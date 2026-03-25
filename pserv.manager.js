/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["interval", 30000],
        ["once", false],
        ["prefix", "shade"],
        ["reserve-cash", 0],
        ["spend-ratio", 1],
        ["verbose", true],
    ]);

    disableLogs(ns);

    const prefix = String(flags.prefix || "shade");
    const reserveCash = Math.max(0, Number(flags["reserve-cash"]) || 0);
    const spendRatio = clampNumber(flags["spend-ratio"], 0.01, 1, 1);
    const interval = Math.max(1000, Number(flags.interval) || 30000);
    const verbose = Boolean(flags.verbose);

    while (true) {
        const result = managePurchasedServers(ns, {
            prefix,
            reserveCash,
            spendRatio,
            verbose,
        });

        if (verbose && result.action === "idle") {
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

    if (purchased.length < limit) {
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
            ns.tprint(`[PSERV] New hull commissioned. host=${host} ram=${formatRam(ram)} cost=${formatMoney(ns, cost)} fleet=${purchased.length + 1}/${limit}`);
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

    const upgrade = chooseUpgrade(ns, purchased, budget, maxRam);
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

    ns.killall(upgrade.host);
    if (!ns.deleteServer(upgrade.host)) {
        return {
            action: "idle",
            count: purchased.length,
            limit,
            cash,
            nextAction: `delete failed for ${upgrade.host}`,
        };
    }

    const newHost = ns.purchaseServer(upgrade.host, upgrade.newRam);
    if (newHost) {
        ns.tprint(`[PSERV] Hull refit complete. host=${newHost} ram=${formatRam(upgrade.currentRam)}->${formatRam(upgrade.newRam)} cost=${formatMoney(ns, upgrade.cost)}`);
        return { action: "upgrade", count: purchased.length, limit, cash: cash - upgrade.cost };
    }

    ns.tprint(`[PSERV] Refit failure. host=${upgrade.host} targetRam=${formatRam(upgrade.newRam)} drydock is empty.`);
    return { action: "idle", count: purchased.length - 1, limit, cash, nextAction: "manual intervention needed" };
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

function chooseUpgrade(ns, purchased, budget, maxRam) {
    const servers = purchased
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
        "purchaseServer",
        "deleteServer",
        "killall",
    ].forEach(fn => ns.disableLog(fn));
}

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

function formatMoney(ns, amount) {
    return ns.formatNumber ? `$${ns.formatNumber(amount, 2)}` : `$${Math.round(amount)}`;
}

function formatRam(ram) {
    return `${ram}GB`;
}
