/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["interval", 30000],
        ["once", false],
        ["spend-ratio", 1],
        ["max-nodes", 999],
        ["verbose", true],
    ]);

    disableLogs(ns);

    const options = {
        interval: Math.max(1000, Number(flags.interval) || 30000),
        spendRatio: clampNumber(flags["spend-ratio"], 0.01, 1, 1),
        maxNodes: Math.max(0, Math.floor(Number(flags["max-nodes"]) || 999)),
        verbose: parseBooleanFlag(flags.verbose, true),
    };

    while (true) {
        const result = manageHacknet(ns, options);

        if (options.verbose) {
            ns.tprint(
                `[HACKNET] nodes=${result.nodes} production=${formatMoney(ns, result.productionPerSec)}/s generated=${formatMoney(ns, result.generated)} spent=${formatMoney(ns, result.spent)} allowance=${formatMoney(ns, result.allowance)} cash=${formatMoney(ns, result.cash)}`
            );
            ns.tprint(`[HACKNET] action=${result.action} detail=${result.detail}`);
        }

        if (flags.once) return;
        await ns.sleep(options.interval);
    }
}

function manageHacknet(ns, options) {
    const cash = ns.getServerMoneyAvailable("home");
    const generated = getHacknetGenerated(ns);
    const spent = getHacknetSpent(ns);
    const allowance = Math.max(0, (generated * options.spendRatio) - spent);
    const budget = Math.max(0, Math.min(cash, allowance));
    const nodes = ns.hacknet.numNodes();
    const productionPerSec = getTotalProductionPerSec(ns, nodes);

    const candidate = chooseBestHacknetAction(ns, nodes, budget, options.maxNodes);
    if (!candidate) {
        return {
            action: "idle",
            detail: budget <= 0
                ? "no reinvestment budget available"
                : "no affordable hacknet action found",
            nodes,
            productionPerSec,
            generated,
            spent,
            allowance,
            cash,
        };
    }

    const success = applyHacknetAction(ns, candidate);
    return {
        action: success ? candidate.type : "idle",
        detail: success
            ? `${candidate.label} cost=${formatMoney(ns, candidate.cost)} score=${candidate.score.toFixed(4)}`
            : `failed to apply ${candidate.label}`,
        nodes: ns.hacknet.numNodes(),
        productionPerSec: getTotalProductionPerSec(ns, ns.hacknet.numNodes()),
        generated,
        spent: getHacknetSpent(ns),
        allowance: Math.max(0, (getHacknetGenerated(ns) * options.spendRatio) - getHacknetSpent(ns)),
        cash: ns.getServerMoneyAvailable("home"),
    };
}

function chooseBestHacknetAction(ns, nodes, budget, maxNodes) {
    const candidates = [];

    if (nodes < maxNodes) {
        const cost = ns.hacknet.getPurchaseNodeCost();
        const gain = estimateNewNodeProduction(ns, nodes);
        pushCandidate(candidates, {
            type: "purchase",
            label: "purchase node",
            cost,
            gain,
            apply: () => ns.hacknet.purchaseNode() >= 0,
        }, budget);
    }

    for (let i = 0; i < nodes; i++) {
        const stats = ns.hacknet.getNodeStats(i);

        pushCandidate(candidates, {
            type: "level",
            label: `upgrade level node=${i}`,
            cost: ns.hacknet.getLevelUpgradeCost(i, 1),
            gain: estimateLevelGain(stats),
            apply: () => ns.hacknet.upgradeLevel(i, 1),
        }, budget);

        pushCandidate(candidates, {
            type: "ram",
            label: `upgrade ram node=${i}`,
            cost: ns.hacknet.getRamUpgradeCost(i, 1),
            gain: estimateRamGain(stats),
            apply: () => ns.hacknet.upgradeRam(i, 1),
        }, budget);

        pushCandidate(candidates, {
            type: "core",
            label: `upgrade core node=${i}`,
            cost: ns.hacknet.getCoreUpgradeCost(i, 1),
            gain: estimateCoreGain(stats),
            apply: () => ns.hacknet.upgradeCore(i, 1),
        }, budget);
    }

    candidates.sort((a, b) =>
        b.score - a.score ||
        a.cost - b.cost ||
        a.label.localeCompare(b.label)
    );

    return candidates[0] || null;
}

function pushCandidate(candidates, candidate, budget) {
    if (!Number.isFinite(candidate.cost) || candidate.cost <= 0) return;
    if (candidate.cost > budget) return;
    if (!Number.isFinite(candidate.gain) || candidate.gain <= 0) return;

    candidates.push({
        ...candidate,
        score: candidate.gain / candidate.cost,
    });
}

function applyHacknetAction(ns, candidate) {
    try {
        return Boolean(candidate.apply());
    } catch {
        return false;
    }
}

function getHacknetGenerated(ns) {
    try {
        return ns.getMoneySources().sinceInstall.hacknet;
    } catch {
        return 0;
    }
}

function getHacknetSpent(ns) {
    try {
        return ns.getMoneySources().sinceInstall.hacknet_expenses;
    } catch {
        return 0;
    }
}

function getTotalProductionPerSec(ns, nodes) {
    let total = 0;
    for (let i = 0; i < nodes; i++) {
        total += Number(ns.hacknet.getNodeStats(i).production) || 0;
    }
    return total;
}

function estimateNewNodeProduction(ns, nodes) {
    if (nodes <= 0) return 1;

    let minProduction = Number.POSITIVE_INFINITY;
    for (let i = 0; i < nodes; i++) {
        const production = Number(ns.hacknet.getNodeStats(i).production) || 0;
        if (production > 0 && production < minProduction) {
            minProduction = production;
        }
    }

    return Number.isFinite(minProduction) ? minProduction : 1;
}

function estimateLevelGain(stats) {
    const production = Number(stats.production) || 0;
    const level = Math.max(1, Number(stats.level) || 1);
    return Math.max(0.001, production / level);
}

function estimateRamGain(stats) {
    const production = Number(stats.production) || 0;
    return Math.max(0.001, production);
}

function estimateCoreGain(stats) {
    const production = Number(stats.production) || 0;
    const cores = Math.max(1, Number(stats.cores) || 1);
    return Math.max(0.001, production / (cores + 1));
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
