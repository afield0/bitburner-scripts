import {
    DECOMMISSION_FILE,
    SILENT_ENABLE_FILE,
    WORKER_SCRIPTS
} from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["interval", 30000],
        ["once", false],
        ["prefix", "shade"],
        ["reserve-cash", 0],
        ["pause-spare-ratio", 0.25],
        ["pause-spare-gb", 0],
        ["spend-ratio", 1],
        ["verbose", "true"],
    ]);

    disableLogs(ns);

    const prefix = String(flags.prefix || "shade");
    const reserveCash = Math.max(0, parseMoneyInput(flags["reserve-cash"], 0));
    const pauseSpareRatio = clampNumber(flags["pause-spare-ratio"], 0, 1, 0.25);
    const pauseSpareGb = Math.max(0, Number(flags["pause-spare-gb"]) || 0);
    const spendRatio = clampNumber(flags["spend-ratio"], 0.01, 1, 1);
    const interval = Math.max(1000, Number(flags.interval) || 30000);
    const verbose = parseBooleanFlag(flags.verbose, true);

    while (true) {
        const silent = shouldSilenceOutput(ns);
        const result = managePurchasedServers(ns, {
            prefix,
            reserveCash,
            pauseSpareRatio,
            pauseSpareGb,
            spendRatio,
            verbose: verbose && !silent,
        });

        if (verbose && !silent && result.action === "idle") {
            ns.tprint(`[PSERV] Holding pattern. purchased=${result.count}/${result.limit} cash=${formatMoney(ns, result.cash)} next=${result.nextAction}`);
        }

        if (flags.once) return;
        await ns.sleep(interval);
    }
}

function managePurchasedServers(ns, opts) {
    const limit = ns.getPurchasedServerLimit();
    const purchased = ns.getPurchasedServers().sort();
    const maxRam = ns.getPurchasedServerMaxRam();
    const cash = ns.getServerMoneyAvailable("home");
    const budget = Math.max(0, (cash - opts.reserveCash) * opts.spendRatio);
    const decommissioned = getDecommissionedHosts(ns, purchased);
    const spareCapacity = getPurchasedFleetSpareCapacity(ns, purchased, decommissioned);

    if (purchased.length < limit) {
        if (shouldPausePurchasing(spareCapacity, opts)) {
            return {
                action: "idle",
                count: purchased.length,
                limit,
                cash,
                nextAction: `spare capacity high free=${formatRam(spareCapacity.freeRam)} total=${formatRam(spareCapacity.totalRam)}`,
            };
        }

        const ram = getFillPurchaseRam(ns, budget, maxRam);
        if (ram === 0) {
            return {
                action: "idle",
                count: purchased.length,
                limit,
                cash,
                nextAction: `need ${formatMoney(ns, ns.getPurchasedServerCost(2))} for next 2GB hull`,
            };
        }

        const name = nextPurchasedServerName(prefixSafe(opts.prefix), purchased, limit);
        const cost = ns.getPurchasedServerCost(ram);
        const host = ns.purchaseServer(name, ram);

        if (host) {
            if (opts.verbose) {
                ns.tprint(`[PSERV] New hull commissioned. host=${host} ram=${formatRam(ram)} cost=${formatMoney(ns, cost)} fleet=${purchased.length + 1}/${limit}`);
            }
            return { action: "purchase", count: purchased.length + 1, limit, cash: cash - cost };
        }

        return {
            action: "idle",
            count: purchased.length,
            limit,
            cash,
            nextAction: `purchase failed for ${name} at ${formatRam(ram)}`,
        };
    }

    const draining = getDrainingUpgrade(ns, purchased, decommissioned);
    if (draining) {
        const activeWorkers = countManagedWorkers(ns, draining);
        if (activeWorkers > 0) {
            return {
                action: "idle",
                count: purchased.length,
                limit,
                cash,
                nextAction: `waiting for ${draining} to drain workers=${activeWorkers}`,
            };
        }

        const upgradeRam = getUpgradeTargetRam(ns, ns.getServerMaxRam(draining), budget, maxRam);
        if (upgradeRam === 0) {
            writeDecommissionedHosts(ns, removeDecommissionedHost(decommissioned, draining));
            return {
                action: "idle",
                count: purchased.length,
                limit,
                cash,
                nextAction: `budget slipped below upgrade target for ${draining}`,
            };
        }

        ns.killall(draining);
        if (!ns.deleteServer(draining)) {
            return {
                action: "idle",
                count: purchased.length,
                limit,
                cash,
                nextAction: `delete failed for ${draining}`,
            };
        }

        const cost = ns.getPurchasedServerCost(upgradeRam);
        const newHost = ns.purchaseServer(draining, upgradeRam);
        if (newHost) {
            writeDecommissionedHosts(ns, removeDecommissionedHost(decommissioned, draining));
            if (opts.verbose) {
                ns.tprint(`[PSERV] Hull refit complete. host=${newHost} ram=${formatRam(upgradeRam)} cost=${formatMoney(ns, cost)}`);
            }
            return { action: "upgrade", count: purchased.length, limit, cash: cash - cost };
        }

        writeDecommissionedHosts(ns, removeDecommissionedHost(decommissioned, draining));
        if (opts.verbose) {
            ns.tprint(`[PSERV] Refit failure. host=${draining} targetRam=${formatRam(upgradeRam)} drydock is empty.`);
        }
        return { action: "idle", count: purchased.length - 1, limit, cash, nextAction: "manual intervention needed" };
    }

    if (shouldPausePurchasing(spareCapacity, opts)) {
        return {
            action: "idle",
            count: purchased.length,
            limit,
            cash,
            nextAction: `spare capacity high free=${formatRam(spareCapacity.freeRam)} total=${formatRam(spareCapacity.totalRam)}`,
        };
    }

    const upgrade = chooseUpgrade(ns, purchased, budget, maxRam, decommissioned);
    if (!upgrade) {
        const nextCost = getNextUpgradeCost(ns, purchased, maxRam);
        return {
            action: "idle",
            count: purchased.length,
            limit,
            cash,
            nextAction: nextCost === 0
                ? "fleet at maximum RAM"
                : `need ${formatMoney(ns, nextCost)} for next upgrade`,
        };
    }

    writeDecommissionedHosts(ns, addDecommissionedHost(decommissioned, upgrade.host));
    if (opts.verbose) {
        ns.tprint(`[PSERV] Decommission beacon lit. host=${upgrade.host} current=${formatRam(upgrade.currentRam)} target=${formatRam(upgrade.newRam)} waiting for workers to clear.`);
    }
    return {
        action: "decommission",
        count: purchased.length,
        limit,
        cash,
        nextAction: `draining ${upgrade.host} for upgrade`,
    };
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

        const cost = ns.getPurchasedServerCost(bestAffordable);
        const value = bestAffordable - server.ram;
        const candidate = {
            host: server.host,
            currentRam: server.ram,
            newRam: bestAffordable,
            cost,
            value,
        };

        if (!best) {
            best = candidate;
            continue;
        }

        if (candidate.currentRam < best.currentRam) {
            best = candidate;
            continue;
        }

        if (candidate.currentRam === best.currentRam && candidate.newRam > best.newRam) {
            best = candidate;
        }
    }

    return best;
}

function getUpgradeTargetRam(ns, currentRam, budget, maxRam) {
    if (currentRam >= maxRam) return 0;

    let candidateRam = currentRam * 2;
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

    return bestAffordable;
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

function getPurchasedFleetSpareCapacity(ns, purchased, decommissioned) {
    let totalRam = 0;
    let freeRam = 0;

    for (const host of purchased) {
        if (decommissioned.has(host)) continue;
        const maxRam = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        totalRam += maxRam;
        freeRam += Math.max(0, maxRam - usedRam);
    }

    return { totalRam, freeRam };
}

function shouldPausePurchasing(spareCapacity, opts) {
    if (spareCapacity.totalRam <= 0) {
        return false;
    }

    const freeRatio = spareCapacity.freeRam / spareCapacity.totalRam;
    return freeRatio >= opts.pauseSpareRatio && spareCapacity.freeRam >= opts.pauseSpareGb;
}

function nextPurchasedServerName(prefix, purchased, limit) {
    const used = new Set(purchased);
    for (let i = 0; i < limit; i++) {
        const name = `${prefix}-${i}`;
        if (!used.has(name)) {
            return name;
        }
    }
    return `${prefix}-${Date.now()}`;
}

function prefixSafe(prefix) {
    return prefix.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 16) || "shade";
}

function disableLogs(ns) {
    [
        "sleep",
        "getServerMoneyAvailable",
        "getPurchasedServers",
        "getPurchasedServerCost",
        "getPurchasedServerLimit",
        "getPurchasedServerMaxRam",
        "getServerMaxRam",
        "getServerUsedRam",
        "fileExists",
        "purchaseServer",
        "deleteServer",
        "killall",
        "ps",
        "read",
        "write",
        "rm",
    ].forEach(fn => ns.disableLog(fn));
}

function shouldSilenceOutput(ns) {
    return ns.fileExists(SILENT_ENABLE_FILE, "home");
}

function getDecommissionedHosts(ns, purchased) {
    if (!ns.fileExists(DECOMMISSION_FILE, "home")) {
        return new Set();
    }

    const purchasedSet = new Set(purchased);
    const hosts = new Set(
        ns.read(DECOMMISSION_FILE)
            .split("\n")
            .map(line => line.trim())
            .filter(host => host && purchasedSet.has(host))
    );

    writeDecommissionedHosts(ns, hosts);
    return hosts;
}

function writeDecommissionedHosts(ns, hosts) {
    const lines = [...hosts].sort();
    if (lines.length === 0) {
        if (ns.fileExists(DECOMMISSION_FILE, "home")) {
            ns.rm(DECOMMISSION_FILE, "home");
        }
        return;
    }

    ns.write(DECOMMISSION_FILE, `${lines.join("\n")}\n`, "w");
}

function addDecommissionedHost(hosts, host) {
    const next = new Set(hosts);
    next.add(host);
    return next;
}

function removeDecommissionedHost(hosts, host) {
    const next = new Set(hosts);
    next.delete(host);
    return next;
}

function getDrainingUpgrade(ns, purchased, decommissioned) {
    for (const host of purchased.sort()) {
        if (decommissioned.has(host)) {
            return host;
        }
    }
    return null;
}

function countManagedWorkers(ns, host) {
    return ns.ps(host)
        .filter(proc => WORKER_SCRIPTS.includes(proc.filename))
        .reduce((sum, proc) => sum + (Number(proc.threads) || 0), 0);
}

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
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

function parseBooleanFlag(value, fallback) {
    if (typeof value === "boolean") return value;

    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
    if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
    return fallback;
}

function formatMoney(ns, amount) {
    return ns.formatNumber ? `$${ns.formatNumber(amount, 2)}` : `$${Math.round(amount)}`;
}

function formatRam(ram) {
    return `${ram}GB`;
}
