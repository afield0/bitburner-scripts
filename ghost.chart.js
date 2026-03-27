import {
    VERSION,
    SECURITY_BUFFER,
    MONEY_THRESHOLD
} from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["all", false],
        ["paths", false],
        ["sort", "score"],
    ]);

    disableLogs(ns);

    const playerLevel = ns.getHackingLevel();
    const network = discoverNetwork(ns, "home");
    const rows = network.order
        .map(host => buildHostRow(ns, host, playerLevel, network.depths, network.parents))
        .filter(row => Boolean(flags.all) || row.hackable);

    sortRows(rows, String(flags.sort || "score").toLowerCase());

    const summary = summarizeRows(rows);
    ns.tprint(
        `[CHART ${VERSION}] network=${network.order.length} shown=${rows.length} hackable=${summary.hackable} rooted=${summary.rooted} ready=${summary.ready} rootable=${summary.rootable} locked=${summary.locked} playerHack=${playerLevel}`
    );
    ns.tprint(
        `[CHART ${VERSION}] money total=${formatMoney(ns, summary.totalMoney)} available=${formatMoney(ns, summary.availableMoney)} best=${summary.bestTarget || "none"} richest=${summary.richestTarget || "none"}`
    );

    for (const row of rows) {
        const pathSuffix = flags.paths ? ` path=${row.path}` : "";
        ns.tprint(
            `[CHART ${VERSION}] host=${row.host} state=${row.state} depth=${row.depth} req=${row.requiredHack} ports=${row.portsRequired} money=${formatMoney(ns, row.money)}/${formatMoney(ns, row.maxMoney)} moneyPct=${formatPercent(row.money, row.maxMoney)} sec=${row.security.toFixed(2)}/${row.minSecurity.toFixed(2)} ram=${formatRam(row.maxRam)} score=${formatScore(row.score)}${pathSuffix}`
        );
    }
}

function buildHostRow(ns, host, playerLevel, depths, parents) {
    const rooted = ns.hasRootAccess(host);
    const requiredHack = ns.getServerRequiredHackingLevel(host);
    const portsRequired = ns.getServerNumPortsRequired(host);
    const maxMoney = ns.getServerMaxMoney(host);
    const money = ns.getServerMoneyAvailable(host);
    const minSecurity = ns.getServerMinSecurityLevel(host);
    const security = ns.getServerSecurityLevel(host);
    const maxRam = ns.getServerMaxRam(host);
    const hackable = host !== "home" && maxMoney > 0;
    const canHackNow = hackable && rooted && requiredHack <= playerLevel;
    const rootableNow = !rooted && requiredHack <= playerLevel && getAvailablePortOpeners(ns) >= portsRequired;
    const moneyReady = maxMoney > 0 && money >= maxMoney * MONEY_THRESHOLD;
    const securityReady = security <= minSecurity + SECURITY_BUFFER;
    const score = canHackNow ? scoreMoneyTarget(ns, host) : 0;
    const path = buildPath(host, parents);
    const state = getHostState({
        host,
        hackable,
        rooted,
        rootableNow,
        canHackNow,
        moneyReady,
        securityReady,
    });

    return {
        host,
        rooted,
        rootableNow,
        hackable,
        canHackNow,
        requiredHack,
        portsRequired,
        maxMoney,
        money,
        minSecurity,
        security,
        maxRam,
        score,
        path,
        depth: depths.get(host) || 0,
        state,
    };
}

function getHostState(ctx) {
    if (ctx.host === "home") return "home";
    if (!ctx.hackable) return ctx.rooted ? "utility" : "locked";
    if (!ctx.rooted) return ctx.rootableNow ? "rootable" : "locked";
    if (!ctx.canHackNow) return "skill-gap";
    if (!ctx.securityReady) return "prep-weaken";
    if (!ctx.moneyReady) return "prep-grow";
    return "ready";
}

function summarizeRows(rows) {
    let hackable = 0;
    let rooted = 0;
    let ready = 0;
    let rootable = 0;
    let locked = 0;
    let totalMoney = 0;
    let availableMoney = 0;
    let bestTarget = "";
    let bestScore = -1;
    let richestTarget = "";
    let richestMoney = -1;

    for (const row of rows) {
        if (row.hackable) {
            hackable += 1;
            totalMoney += row.maxMoney;
            availableMoney += row.money;
        }
        if (row.rooted) rooted += 1;
        if (row.state === "ready") ready += 1;
        if (row.state === "rootable") rootable += 1;
        if (row.state === "locked" || row.state === "skill-gap") locked += 1;
        if (row.score > bestScore) {
            bestScore = row.score;
            bestTarget = row.hackable ? row.host : bestTarget;
        }
        if (row.maxMoney > richestMoney) {
            richestMoney = row.maxMoney;
            richestTarget = row.hackable ? row.host : richestTarget;
        }
    }

    return {
        hackable,
        rooted,
        ready,
        rootable,
        locked,
        totalMoney,
        availableMoney,
        bestTarget,
        richestTarget,
    };
}

function discoverNetwork(ns, start) {
    const visited = new Set();
    const queue = [start];
    const order = [];
    const depths = new Map([[start, 0]]);
    const parents = new Map([[start, ""]]);

    while (queue.length > 0) {
        const host = queue.shift();
        if (visited.has(host)) continue;
        visited.add(host);
        order.push(host);

        for (const neighbor of ns.scan(host).sort()) {
            if (visited.has(neighbor)) continue;
            if (!depths.has(neighbor)) {
                depths.set(neighbor, (depths.get(host) || 0) + 1);
                parents.set(neighbor, host);
            }
            queue.push(neighbor);
        }
    }

    return { order, depths, parents };
}

function buildPath(host, parents) {
    const parts = [];
    let current = host;

    while (current) {
        parts.push(current);
        current = parents.get(current) || "";
    }

    return parts.reverse().join(" -> ");
}

function getAvailablePortOpeners(ns) {
    let count = 0;
    if (ns.fileExists("BruteSSH.exe", "home")) count += 1;
    if (ns.fileExists("FTPCrack.exe", "home")) count += 1;
    if (ns.fileExists("relaySMTP.exe", "home")) count += 1;
    if (ns.fileExists("HTTPWorm.exe", "home")) count += 1;
    if (ns.fileExists("SQLInject.exe", "home")) count += 1;
    return count;
}

function scoreMoneyTarget(ns, host) {
    const maxMoney = ns.getServerMaxMoney(host);
    const minSec = ns.getServerMinSecurityLevel(host);
    const chance = ns.hackAnalyzeChance ? ns.hackAnalyzeChance(host) : 1;
    return (maxMoney * chance) / Math.max(1, minSec);
}

function sortRows(rows, sortKey) {
    const comparator = getSortComparator(sortKey);
    rows.sort((a, b) => comparator(a, b) || a.host.localeCompare(b.host));
}

function getSortComparator(sortKey) {
    if (sortKey === "name" || sortKey === "host") {
        return (a, b) => a.host.localeCompare(b.host);
    }
    if (sortKey === "depth") {
        return (a, b) => a.depth - b.depth;
    }
    if (sortKey === "req") {
        return (a, b) => a.requiredHack - b.requiredHack;
    }
    if (sortKey === "money") {
        return (a, b) => b.maxMoney - a.maxMoney;
    }
    if (sortKey === "ram") {
        return (a, b) => b.maxRam - a.maxRam;
    }
    return (a, b) => b.score - a.score;
}

function disableLogs(ns) {
    [
        "scan",
        "fileExists",
        "hasRootAccess",
        "getHackingLevel",
        "getServerRequiredHackingLevel",
        "getServerNumPortsRequired",
        "getServerMaxMoney",
        "getServerMoneyAvailable",
        "getServerMinSecurityLevel",
        "getServerSecurityLevel",
        "getServerMaxRam",
    ].forEach(fn => ns.disableLog(fn));
}

function formatMoney(ns, amount) {
    if (amount <= 0) return "$0";
    return ns.formatNumber ? `$${ns.formatNumber(amount, 2)}` : `$${Math.round(amount)}`;
}

function formatPercent(value, total) {
    if (total <= 0) return "0.0%";
    return `${((value / total) * 100).toFixed(1)}%`;
}

function formatRam(ram) {
    return `${ram}GB`;
}

function formatScore(score) {
    if (!Number.isFinite(score) || score <= 0) return "0";
    return score >= 1000 ? score.toExponential(2) : score.toFixed(2);
}
