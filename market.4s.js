const COMMISSION = 100000;

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["once", false],
        ["interval", 6000],
        ["reserve-cash", 10000000],
        ["max-position-ratio", 0.2],
        ["buy-forecast", 0.6],
        ["sell-forecast", 0.55],
        ["min-volatility", 0],
        ["max-holdings", 5],
        ["verbose", "true"],
    ]);

    disableLogs(ns);

    if (!checkMarketAccess(ns)) {
        return;
    }

    const options = {
        interval: Math.max(1000, Number(flags.interval) || 6000),
        reserveCash: Math.max(0, parseMoneyInput(flags["reserve-cash"], 0)),
        maxPositionRatio: clampNumber(flags["max-position-ratio"], 0.01, 1, 0.2),
        buyForecast: clampNumber(flags["buy-forecast"], 0.5, 0.99, 0.6),
        sellForecast: clampNumber(flags["sell-forecast"], 0.5, 0.99, 0.55),
        minVolatility: Math.max(0, Number(flags["min-volatility"]) || 0),
        maxHoldings: Math.max(1, Math.floor(Number(flags["max-holdings"]) || 5)),
        verbose: parseBooleanFlag(flags.verbose, true),
    };

    if (options.sellForecast >= options.buyForecast) {
        ns.tprint(`[MARKET 4S] Invalid thresholds. --sell-forecast must be lower than --buy-forecast.`);
        return;
    }

    while (true) {
        const result = runTradingPass(ns, options);

        if (options.verbose) {
            ns.tprint(
                `[MARKET 4S] cash=${formatMoney(ns, result.cash)} reserve=${formatMoney(ns, options.reserveCash)} invested=${formatMoney(ns, result.investedCapital)} holdings=${result.holdings}/${options.maxHoldings} unrealized=${formatMoney(ns, result.unrealizedProfit)} actions=${result.actions.length}`
            );

            for (const action of result.actions) {
                ns.tprint(`[MARKET 4S] ${action}`);
            }

            if (result.actions.length === 0) {
                ns.tprint(`[MARKET 4S] No trades. best=${result.bestCandidate || "none"} weakest=${result.weakestHolding || "none"}`);
            }
        }

        if (flags.once) return;
        await ns.sleep(options.interval);
    }
}

function runTradingPass(ns, options) {
    const symbols = ns.stock.getSymbols();
    const snapshots = symbols.map(symbol => getSnapshot(ns, symbol));
    const actions = [];

    const holdings = snapshots.filter(snapshot => snapshot.longShares > 0);
    const investedCapital = holdings.reduce((sum, snapshot) => sum + (snapshot.longShares * snapshot.longAveragePrice), 0);
    const unrealizedProfit = holdings.reduce((sum, snapshot) => sum + snapshot.longProfit, 0);

    for (const snapshot of holdings
        .filter(snapshot => shouldSell(snapshot, options))
        .sort((a, b) => a.forecast - b.forecast || b.positionValue - a.positionValue || a.symbol.localeCompare(b.symbol))) {
        const soldPrice = ns.stock.sellStock(snapshot.symbol, snapshot.longShares);
        if (soldPrice > 0) {
            const revenue = soldPrice * snapshot.longShares;
            const profit = revenue - (snapshot.longShares * snapshot.longAveragePrice) - COMMISSION;
            actions.push(`sell symbol=${snapshot.symbol} shares=${snapshot.longShares} price=${formatMoney(ns, soldPrice)} profit=${formatMoney(ns, profit)} forecast=${formatForecast(snapshot.forecast)}`);
            snapshot.longShares = 0;
            snapshot.positionValue = 0;
        }
    }

    const updatedCash = ns.getServerMoneyAvailable("home");
    const updatedSnapshots = symbols.map(symbol => getSnapshot(ns, symbol));
    const updatedHoldings = updatedSnapshots.filter(snapshot => snapshot.longShares > 0);
    const openSlots = Math.max(0, options.maxHoldings - updatedHoldings.length);
    const buyCandidates = updatedSnapshots
        .filter(snapshot => shouldBuy(snapshot, options))
        .sort((a, b) => scoreBuyCandidate(b) - scoreBuyCandidate(a) || a.symbol.localeCompare(b.symbol))
        .slice(0, openSlots > 0 ? openSlots : 0);

    let spendableCash = Math.max(0, updatedCash - options.reserveCash);
    const totalEquity = updatedCash + updatedHoldings.reduce((sum, snapshot) => sum + snapshot.positionValue, 0);
    const positionBudget = Math.max(0, totalEquity * options.maxPositionRatio);

    for (const snapshot of buyCandidates) {
        if (spendableCash <= COMMISSION) break;

        const currentExposure = snapshot.positionValue;
        const targetSpend = Math.max(0, Math.min(positionBudget - currentExposure, spendableCash - COMMISSION));
        const shareBudget = Math.floor(targetSpend / Math.max(1, snapshot.askPrice));
        const shares = Math.min(snapshot.maxShares - snapshot.longShares, shareBudget);
        if (shares <= 0) continue;

        const buyPrice = ns.stock.buyStock(snapshot.symbol, shares);
        if (buyPrice > 0) {
            const cost = (buyPrice * shares) + COMMISSION;
            spendableCash = Math.max(0, spendableCash - cost);
            actions.push(`buy symbol=${snapshot.symbol} shares=${shares} price=${formatMoney(ns, buyPrice)} forecast=${formatForecast(snapshot.forecast)} vol=${snapshot.volatility.toFixed(4)}`);
        }
    }

    const finalSnapshots = symbols.map(symbol => getSnapshot(ns, symbol));
    const finalHoldings = finalSnapshots.filter(snapshot => snapshot.longShares > 0);

    return {
        cash: ns.getServerMoneyAvailable("home"),
        investedCapital: finalHoldings.reduce((sum, snapshot) => sum + (snapshot.longShares * snapshot.longAveragePrice), 0),
        unrealizedProfit: finalHoldings.reduce((sum, snapshot) => sum + snapshot.longProfit, 0),
        holdings: finalHoldings.length,
        actions,
        bestCandidate: buyCandidates[0]?.symbol || "",
        weakestHolding: finalHoldings
            .slice()
            .sort((a, b) => a.forecast - b.forecast || a.symbol.localeCompare(b.symbol))[0]?.symbol || "",
    };
}

function checkMarketAccess(ns) {
    if (!ns.stock.hasWSEAccount()) {
        ns.tprint("[MARKET 4S] Missing WSE account.");
        return false;
    }

    if (!ns.stock.hasTIXAPIAccess()) {
        ns.tprint("[MARKET 4S] Missing TIX API access.");
        return false;
    }

    if (!ns.stock.has4SData()) {
        ns.tprint("[MARKET 4S] Missing 4S Market Data access.");
        return false;
    }

    if (!ns.stock.has4SDataTIXAPI()) {
        ns.tprint("[MARKET 4S] Missing 4S Market Data TIX API access.");
        return false;
    }

    return true;
}

function getSnapshot(ns, symbol) {
    const [longShares, longAveragePrice, shortShares, shortAveragePrice] = ns.stock.getPosition(symbol);
    const bidPrice = ns.stock.getBidPrice(symbol);
    const askPrice = ns.stock.getAskPrice(symbol);
    const forecast = ns.stock.getForecast(symbol);
    const volatility = ns.stock.getVolatility(symbol);
    const maxShares = ns.stock.getMaxShares(symbol);
    const positionValue = longShares * bidPrice;
    const longProfit = longShares > 0
        ? (longShares * (bidPrice - longAveragePrice)) - COMMISSION
        : 0;

    return {
        symbol,
        forecast,
        volatility,
        bidPrice,
        askPrice,
        spread: Math.max(0, askPrice - bidPrice),
        maxShares,
        longShares,
        longAveragePrice,
        shortShares,
        shortAveragePrice,
        positionValue,
        longProfit,
    };
}

function shouldSell(snapshot, options) {
    return snapshot.longShares > 0 && snapshot.forecast <= options.sellForecast;
}

function shouldBuy(snapshot, options) {
    if (snapshot.longShares > 0) return false;
    if (snapshot.shortShares > 0) return false;
    if (snapshot.forecast < options.buyForecast) return false;
    if (snapshot.volatility < options.minVolatility) return false;

    const edge = snapshot.forecast - 0.5;
    const roundTripDrag = (snapshot.spread * 2) + (COMMISSION * 2 / Math.max(1, snapshot.maxShares));
    return edge > 0 && snapshot.askPrice * edge > roundTripDrag;
}

function scoreBuyCandidate(snapshot) {
    return ((snapshot.forecast - 0.5) * 1000) + (snapshot.volatility * 100) - snapshot.spread;
}

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

function parseBooleanFlag(value, fallback) {
    if (typeof value === "boolean") return value;

    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
    if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
    return fallback;
}

function parseMoneyInput(value, fallback) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : fallback;
    }

    const raw = String(value ?? "").trim().toLowerCase();
    if (raw.length === 0) return fallback;

    const match = raw.match(/^(-?\d+(?:\.\d+)?)([kmbt])?$/);
    if (!match) return fallback;

    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) return fallback;

    const suffix = match[2] || "";
    const multipliers = {
        "": 1,
        k: 1e3,
        m: 1e6,
        b: 1e9,
        t: 1e12,
    };

    return numeric * (multipliers[suffix] || 1);
}

function disableLogs(ns) {
    [
        "sleep",
        "getServerMoneyAvailable",
    ].forEach(fn => ns.disableLog(fn));
}

function formatMoney(ns, amount) {
    const numeric = Number(amount) || 0;
    return ns.formatNumber ? `$${ns.formatNumber(numeric, 2)}` : `$${Math.round(numeric)}`;
}

function formatForecast(forecast) {
    return `${(forecast * 100).toFixed(1)}%`;
}
