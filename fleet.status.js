import {
    DECOMMISSION_FILE,
    WORKER_SCRIPTS
} from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["reserve-cash", 0],
        ["sort", "ram"],
    ]);

    disableLogs(ns);

    const reserveCash = Math.max(0, Number(flags["reserve-cash"]) || 0);
    const purchased = ns.getPurchasedServers().sort();
    const decommissioned = getDecommissionedHosts(ns, purchased);
    const sortKey = String(flags.sort || "ram").toLowerCase();

    if (purchased.length === 0) {
        ns.tprint("[FLEET] No purchased servers online.");
        return;
    }

    const limit = ns.getPurchasedServerLimit();
    const maxPurchasedRam = ns.getPurchasedServerMaxRam();
    const cash = ns.getServerMoneyAvailable("home");
    const budget = Math.max(0, cash - reserveCash);
    const rows = purchased.map(host => getHostRow(ns, host, decommissioned));
    const totals = summarizeRows(rows);
    const cheapestUpgradeCost = getNextUpgradeCost(ns, purchased, maxPurchasedRam);
    const nextPurchaseRam = purchased.length < limit ? getFillPurchaseRam(ns, budget, maxPurchasedRam) : 0;
    const affordableUpgrade = chooseUpgrade(ns, purchased, budget, maxPurchasedRam, decommissioned);
    const draining = getDrainingUpgrade(ns, purchased, decommissioned);

    sortRows(rows, sortKey);

    ns.tprint(
        `[FLEET] status purchased=${purchased.length}/${limit} homeCash=${formatMoney(ns, cash)} spendable=${formatMoney(ns, budget)} reserve=${formatMoney(ns, reserveCash)}`
    );
    ns.tprint(
        `[FLEET] capacity total=${formatRam(totals.totalRam)} used=${formatRam(totals.usedRam)} free=${formatRam(totals.freeRam)} freePct=${formatPercent(totals.freeRam, totals.totalRam)} avg=${formatRam(Math.round(totals.totalRam / rows.length))} maxTier=${formatRam(maxPurchasedRam)}`
    );
    ns.tprint(
        `[FLEET] tiers min=${formatRam(totals.minRam)} median=${formatRam(totals.medianRam)} max=${formatRam(totals.maxRam)} decommissioned=${decommissioned.size} draining=${draining || "none"}`
    );
    ns.tprint(
        `[FLEET] upgrades nextPurchase=${nextPurchaseRam > 0 ? formatRam(nextPurchaseRam) : "unaffordable"} nextUpgradeCost=${cheapestUpgradeCost > 0 ? formatMoney(ns, cheapestUpgradeCost) : "maxed"} target=${affordableUpgrade ? `${affordableUpgrade.host}->${formatRam(affordableUpgrade.newRam)}` : "none"}`
    );

    for (const row of rows) {
        ns.tprint(
            `[FLEET] host=${row.host} state=${row.state} ram=${formatRam(row.maxRam)} used=${formatRam(row.usedRam)} free=${formatRam(row.freeRam)} util=${formatPercent(row.usedRam, row.maxRam)} ghostThreads=${row.ghostThreads} active=${row.active}`
        );
    }
}

function getHostRow(ns, host, decommissioned) {
    const maxRam = ns.getServerMaxRam(host);
    const usedRam = ns.getServerUsedRam(host);
    const freeRam = Math.max(0, maxRam - usedRam);
    const activeWorkers = ns.ps(host).filter(proc => WORKER_SCRIPTS.includes(proc.filename));
    const ghostThreads = activeWorkers.reduce((sum, proc) => sum + (Number(proc.threads) || 0), 0);
    const active = activeWorkers.length > 0
        ? activeWorkers.map(proc => `${proc.filename}x${proc.threads}:${String(proc.args[0] || "none")}`).join("|")
        : "idle";
    const state = decommissioned.has(host) ? "draining" : "active";

    return {
        host,
        state,
        maxRam,
        usedRam,
        freeRam,
        ghostThreads,
        active,
    };
}

function summarizeRows(rows) {
    const ramValues = rows.map(row => row.maxRam).sort((a, b) => a - b);
    const totalRam = rows.reduce((sum, row) => sum + row.maxRam, 0);
    const usedRam = rows.reduce((sum, row) => sum + row.usedRam, 0);
    const freeRam = rows.reduce((sum, row) => sum + row.freeRam, 0);
    const mid = Math.floor(ramValues.length / 2);
    const medianRam = ramValues.length % 2 === 0
        ? (ramValues[mid - 1] + ramValues[mid]) / 2
        : ramValues[mid];

    return {
        totalRam,
        usedRam,
        freeRam,
        minRam: ramValues[0] || 0,
        medianRam,
        maxRam: ramValues[ramValues.length - 1] || 0,
    };
}

function sortRows(rows, sortKey) {
    const comparator = getSortComparator(sortKey);
    rows.sort((a, b) => comparator(a, b) || a.host.localeCompare(b.host));
}

function getSortComparator(sortKey) {
    if (sortKey === "name" || sortKey === "host") {
        return (a, b) => a.host.localeCompare(b.host);
    }

    if (sortKey === "used") {
        return (a, b) => b.usedRam - a.usedRam;
    }

    if (sortKey === "free") {
        return (a, b) => b.freeRam - a.freeRam;
    }

    if (sortKey === "threads") {
        return (a, b) => b.ghostThreads - a.ghostThreads;
    }

    return (a, b) => b.maxRam - a.maxRam;
}

function getFillPurchaseRam(ns, budget, maxRam) {
    let ram = 2;
    let best = 0;

    while (ram <= maxRam) {
        const cost = ns.getPurchasedServerCost(ram);
        if (cost <= budget) {
            best = ram;
            ram *= 2;
            continue;
        }
        break;
    }

    return best;
}

function chooseUpgrade(ns, purchased, budget, maxRam, decommissioned) {
    const servers = purchased
        .filter(host => !decommissioned.has(host))
        .map(host => ({ host, ram: ns.getServerMaxRam(host) }))
        .sort((a, b) => a.ram - b.ram || a.host.localeCompare(b.host));

    let best = null;

    for (const server of servers) {
        if (server.ram >= maxRam) continue;

        let candidateRam = server.ram * 2;
        let bestAffordable = 0;

        while (candidateRam <= maxRam) {
            const cost = ns.getPurchasedServerCost(candidateRam);
            if (cost <= budget) {
                bestAffordable = candidateRam;
                candidateRam *= 2;
                continue;
            }
            break;
        }

        if (bestAffordable === 0) continue;

        const candidate = {
            host: server.host,
            currentRam: server.ram,
            newRam: bestAffordable,
        };

        if (!best || candidate.currentRam < best.currentRam || (candidate.currentRam === best.currentRam && candidate.newRam > best.newRam)) {
            best = candidate;
        }
    }

    return best;
}

function getNextUpgradeCost(ns, purchased, maxRam) {
    let cheapest = 0;

    for (const host of purchased) {
        const ram = ns.getServerMaxRam(host);
        if (ram >= maxRam) continue;
        const nextRam = ram * 2;
        const cost = ns.getPurchasedServerCost(nextRam);

        if (cheapest === 0 || cost < cheapest) {
            cheapest = cost;
        }
    }

    return cheapest;
}

function getDecommissionedHosts(ns, purchased) {
    if (!ns.fileExists(DECOMMISSION_FILE, "home")) {
        return new Set();
    }

    const purchasedSet = new Set(purchased);
    return new Set(
        ns.read(DECOMMISSION_FILE)
            .split("\n")
            .map(line => line.trim())
            .filter(host => host && purchasedSet.has(host))
    );
}

function getDrainingUpgrade(ns, purchased, decommissioned) {
    for (const host of purchased.sort()) {
        if (decommissioned.has(host)) {
            return host;
        }
    }
    return null;
}

function disableLogs(ns) {
    [
        "getPurchasedServers",
        "getPurchasedServerLimit",
        "getPurchasedServerMaxRam",
        "getPurchasedServerCost",
        "getServerMoneyAvailable",
        "getServerMaxRam",
        "getServerUsedRam",
        "fileExists",
        "read",
        "ps",
    ].forEach(fn => ns.disableLog(fn));
}

function formatMoney(ns, amount) {
    return ns.formatNumber ? `$${ns.formatNumber(amount, 2)}` : `$${Math.round(amount)}`;
}

function formatPercent(value, total) {
    if (total <= 0) return "0.0%";
    return `${((value / total) * 100).toFixed(1)}%`;
}

function formatRam(ram) {
    return `${ram}GB`;
}
