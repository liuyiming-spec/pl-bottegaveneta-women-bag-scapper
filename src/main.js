import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';

const DEFAULT_START_URL = 'https://www.bottegaveneta.com/en-us/women-collection-us/women-bags';

const toAbsoluteUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('/')) return `https://www.bottegaveneta.com${url}`;
    return null;
};

const normalizePrice = (priceText) => {
    if (!priceText) return null;
    return priceText.replace(/\s+/g, ' ').trim();
};

const scrapeProductsFromDom = () => {
    const cleaned = (text) => (text ? text.replace(/\s+/g, ' ').trim() : null);
    const productMap = new Map();

    const selectors = [
        '[data-testid*="product"]',
        '[class*="product"]',
        'article',
        'li',
        'div',
    ];

    const collectFromNode = (node) => {
        const anchor = node.querySelector('a[href*="/product/"]') || node.querySelector('a[href*="/women-"]') || node.querySelector('a[href]');
        if (!anchor) return;

        const rawUrl = anchor.getAttribute('href');
        const url = rawUrl
            ? (rawUrl.startsWith('http') ? rawUrl : `${window.location.origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`)
            : null;

        if (!url || !/\/product\//.test(url)) return;

        const imageNode = node.querySelector('img');
        const nameNode = node.querySelector('[class*="name"], [class*="title"], h2, h3, p, span');
        const priceNode = node.querySelector('[class*="price"], [data-testid*="price"], [aria-label*="price"]');

        const name = cleaned(nameNode?.textContent) || cleaned(anchor.textContent);
        const price = cleaned(priceNode?.textContent);
        const imageUrl = imageNode?.getAttribute('src') || imageNode?.getAttribute('data-src') || imageNode?.getAttribute('srcset')?.split(' ')[0] || null;

        productMap.set(url, {
            url,
            name,
            price,
            currency: price?.match(/\$/) ? 'USD' : null,
            imageUrl,
            source: 'dom',
        });
    };

    for (const selector of selectors) {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) collectFromNode(node);
        if (productMap.size > 3) break;
    }

    const jsonLdNodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
    for (const jsonLdNode of jsonLdNodes) {
        try {
            const payload = JSON.parse(jsonLdNode.textContent || '{}');
            const candidates = Array.isArray(payload)
                ? payload
                : [payload, ...(Array.isArray(payload?.itemListElement) ? payload.itemListElement : [])];

            for (const candidate of candidates) {
                const item = candidate?.item || candidate;
                if (!item) continue;
                const itemType = Array.isArray(item['@type']) ? item['@type'].join(',') : item['@type'];
                if (!(itemType || '').toLowerCase().includes('product')) continue;

                const url = item.url || item.offers?.url || null;
                if (!url) continue;

                productMap.set(url, {
                    url,
                    name: item.name || null,
                    price: item.offers?.price ? `${item.offers.price}` : null,
                    currency: item.offers?.priceCurrency || null,
                    imageUrl: Array.isArray(item.image) ? item.image[0] : item.image || null,
                    sku: item.sku || null,
                    source: 'jsonld',
                });
            }
        } catch {
            // Ignore invalid JSON-LD blobs.
        }
    }

    return [...productMap.values()].map((product) => ({
        ...product,
        name: cleaned(product.name),
        price: cleaned(product.price),
    }));
};

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
    startUrls = [{ url: DEFAULT_START_URL }],
    maxRequestsPerCrawl = 20,
    maxConcurrency = 8,
    requestTimeoutSecs = 120,
    proxyConfiguration: proxyConfigurationInput,
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigurationInput ?? {
    useApifyProxy: true,
});

const requestQueue = await RequestQueue.open();
for (const requestLike of startUrls) {
    await requestQueue.addRequest(typeof requestLike === 'string' ? { url: requestLike } : requestLike);
}

const crawler = new PlaywrightCrawler({
    requestQueue,
    proxyConfiguration,
    maxRequestsPerCrawl,
    maxConcurrency,
    requestHandlerTimeoutSecs: requestTimeoutSecs,
    maxRequestRetries: 5,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 30,
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
    },
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            await page.setExtraHTTPHeaders({
                'accept-language': 'en-US,en;q=0.9',
            });
        },
    ],
    async requestHandler({ request, page, enqueueLinks, log: crawlerLog }) {
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);

        for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, 2000);
            await page.waitForTimeout(700);
        }

        const rawProducts = await page.evaluate(scrapeProductsFromDom);

        const products = rawProducts
            .map((product) => ({
                ...product,
                url: toAbsoluteUrl(product.url),
                imageUrl: toAbsoluteUrl(product.imageUrl),
                price: normalizePrice(product.price),
            }))
            .filter((product) => product.url && product.name);

        const seen = new Set();
        const uniqueProducts = products.filter((product) => {
            if (seen.has(product.url)) return false;
            seen.add(product.url);
            return true;
        });

        if (uniqueProducts.length === 0) {
            crawlerLog.warning(`No products were parsed on ${request.url}`);
        }

        for (const product of uniqueProducts) {
            await Actor.pushData({
                ...product,
                listingUrl: request.loadedUrl ?? request.url,
                crawledAt: new Date().toISOString(),
            });
        }

        await enqueueLinks({
            selector: 'a[href*="women-collection-us/women-bags"]',
            globs: ['https://www.bottegaveneta.com/**women-collection-us/women-bags**'],
            label: 'LISTING',
        });

        crawlerLog.info(`Parsed ${uniqueProducts.length} products from ${request.url}`);
    },
    failedRequestHandler({ request, error }) {
        log.error(`Request ${request.url} failed too many times`, { error: error.message });
    },
});

await crawler.run();
await Actor.exit();
