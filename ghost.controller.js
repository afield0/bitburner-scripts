import {
    VERSION,
    WORKER_SCRIPTS,
    ALL_SCRIPTS,
    RESERVED_HOME_RAM,
    SECURITY_BUFFER,
    MONEY_THRESHOLD,
    HACK_MONEY_FRACTION,
    CONTROLLER_INTERVAL
} from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["interval", CONTROLLER_INTERVAL],
        ["once", false],
        ["target", ""],
        ["verbose", true],
        ["reserve-home-ram", RESERVED_HOME_RAM],
        ["hack-percent", HACK_MONEY_FRACTION],
    ]);

    disableLogs(ns);

    while (true) {
        const network = discoverNetwork(ns, "home");
        const rooted = [];

        for (const host of network) {
            tryRoot(ns, host);
            if (ns.hasRootAccess(host)) {
                rooted.push(host);
                await ensureScripts(ns, host);
                killOldVersions(ns, host);
            }
        }

        const target = flags.target
            ? String(flags.target)
            : pickBestTarget(ns, network);

        if (!target) {
            if (flags.verbose) {
                ns.tprint(`[GHOST ${VERSION}] No suitable target found. The studio is dark.`);
            }
        } else {
            scheduleFleet(ns, rooted, target, {
                verbose: Boolean(flags.verbose),
                reserveHomeRam: Number(flags["reserve-home-ram"]),
                hackPercent: Number(flags["hack-percent"]),
            });
        }

        if (flags.verbose) {
            ns.tprint(`[GHOST ${VERSION}] Broadcast complete. rooted=${rooted.length} target=${target || "none"}`);
        }

        if (flags.once) return;
        await ns.sleep(Number(flags.interval));
    }
}

function disableLogs(ns) {
    [
        "scan",
        "sleep",
        "scp",
        "exec",
        "ps",
        "kill",
        "fileExists",
        "getServerRequiredHackingLevel",
        "getServerNumPortsRequired",
        "hasRootAccess",
        "getServerMoneyAvailable",
        "getServerMaxMoney",
        "getServerSecurityLevel",
        "getServerMinSecurityLevel",
        "getServerMaxRam",
        "getServerUsedRam",
        "getScriptRam",
        "weakenAnalyze",
        "growthAnalyze",
        "hackAnalyzeThreads",
        "getWeakenTime",
        "getGrowTime",
        "getHackTime",
    ].forEach(fn => ns.disableLog(fn));
}

function discoverNetwork(ns, start) {
    const visited = new Set();
    const stack = [start];
    const result = [];

    while (stack.length > 0) {
        const host = stack.pop();
        if (visited.has(host)) continue;
        visited.add(host);
        result.push(host);

        for (const neighbor of ns.scan(host)) {
            if (!visited.has(neighbor)) stack.push(neighbor);
        }
    }

    return result.sort();
}

function tryRoot(ns, host) {
    if (host === "home") return true;
    if (ns.hasRootAccess(host)) return true;

    if (ns.getHackingLevel() < ns.getServerRequiredHackingLevel(host)) {
        return false;
    }

    let opened = 0;

    if (ns.fileExists("BruteSSH.exe", "home")) {
        try { ns.brutessh(host); opened++; } catch {}
    }
    if (ns.fileExists("FTPCrack.exe", "home")) {
        try { ns.ftpcrack(host); opened++; } catch {}
    }
    if (ns.fileExists("relaySMTP.exe", "home")) {
        try { ns.relaysmtp(host); opened++; } catch {}
    }
    if (ns.fileExists("HTTPWorm.exe", "home")) {
        try { ns.httpworm(host); opened++; } catch {}
    }
    if (ns.fileExists("SQLInject.exe", "home")) {
        try { ns.sqlinject(host); opened++; } catch {}
    }

    const needed = ns.getServerNumPortsRequired(host);
    if (opened < needed) return false;

    try {
        ns.nuke(host);
    } catch {
        return false;
    }

    return ns.hasRootAccess(host);
}

async function ensureScripts(ns, host) {
    if (host === "home") return;
    await ns.scp(ALL_SCRIPTS, host, "home");
}

function killOldVersions(ns, host) {
    for (const proc of ns.ps(host)) {
        if (!isManagedScript(proc.filename)) continue;

        const procVersion = proc.args.length > 1
            ? String(proc.args[1])
            : proc.filename === "ghost.controller.js" && proc.args.length > 0
                ? String(proc.args[0])
                : "unknown";

        if (procVersion !== VERSION) {
            ns.kill(proc.pid);
        }
    }
}

function isManagedScript(filename) {
    return filename === "ghost.controller.js" || WORKER_SCRIPTS.includes(filename);
}

function pickBestTarget(ns, hosts) {
    const candidates = hosts.filter(host => {
        if (host === "home") return false;
        if (!ns.hasRootAccess(host)) return false;
        if (ns.getServerMaxMoney(host) <= 0) return false;
        if (ns.getServerRequiredHackingLevel(host) > ns.getHackingLevel()) return false;
        return true;
    });

    candidates.sort((a, b) => scoreTarget(ns, b) - scoreTarget(ns, a));
    return candidates[0] || null;
}

function scoreTarget(ns, host) {
    const maxMoney = ns.getServerMaxMoney(host);
    const minSec = ns.getServerMinSecurityLevel(host);
    const chance = ns.hackAnalyzeChance ? ns.hackAnalyzeChance(host) : 1;
    return (maxMoney * chance) / Math.max(1, minSec);
}

function scheduleFleet(ns, rootedHosts, target, opts) {
    const mode = selectMode(ns, target);
    const script = getWorkerScript(mode);
    const neededThreads = getNeededThreadsForMode(ns, target, mode, opts.hackPercent);
    const allocated = allocateThreadsAcrossFleet(
        ns,
        rootedHosts,
        script,
        target,
        neededThreads,
        VERSION,
        opts
    );
    const actionTime = getActionTime(ns, target, mode);
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const leftover = Math.max(0, neededThreads - allocated.allocatedThreads);

    if (opts.verbose) {
        ns.tprint(
            `[GHOST ${VERSION}] Signal locked. target=${target} mode=${mode} needed=${neededThreads} allocated=${allocated.allocatedThreads} leftover=${leftover} eta=${formatDuration(ns, actionTime)} sec=${security.toFixed(2)}/${minSecurity.toFixed(2)} money=${formatMoney(ns, money)}/${formatMoney(ns, maxMoney)}`
        );
    }
}

function selectMode(ns, target) {
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    if (security > minSecurity + SECURITY_BUFFER) {
        return "weaken";
    }

    if (money < maxMoney * MONEY_THRESHOLD) {
        return "grow";
    }

    return "hack";
}

function getWorkerScript(mode) {
    if (mode === "weaken") return "ghost.weaken.js";
    if (mode === "grow") return "ghost.grow.js";
    return "ghost.hack.js";
}

function getNeededThreadsForMode(ns, target, mode, hackFraction) {
    if (mode === "weaken") {
        return getNeededWeakenThreads(ns, target);
    }

    if (mode === "grow") {
        return getNeededGrowThreads(ns, target);
    }

    return getNeededHackThreads(ns, target, hackFraction);
}

function getNeededWeakenThreads(ns, target) {
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const securityDelta = Math.max(0, security - minSecurity);
    const weakenPerThread = Math.max(0, ns.weakenAnalyze(1, 1));

    if (securityDelta <= 0 || weakenPerThread <= 0) {
        return 0;
    }

    return Math.ceil(securityDelta / weakenPerThread);
}

function getNeededGrowThreads(ns, target) {
    const currentMoney = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    if (maxMoney <= 0 || currentMoney >= maxMoney) {
        return 0;
    }

    const safeMoney = Math.max(1, currentMoney);
    const multiplier = Math.max(1, maxMoney / safeMoney);

    if (!Number.isFinite(multiplier) || multiplier <= 1) {
        return 0;
    }

    try {
        const threads = ns.growthAnalyze(target, multiplier, 1);
        return sanitizeThreadCount(threads);
    } catch {
        return 0;
    }
}

function getNeededHackThreads(ns, target, hackFraction) {
    const maxMoney = ns.getServerMaxMoney(target);
    const fraction = clampNumber(hackFraction, 0.01, 0.99, HACK_MONEY_FRACTION);

    if (maxMoney <= 0) {
        return 0;
    }

    const desiredHackAmount = Math.max(1, maxMoney * fraction);

    try {
        const threads = ns.hackAnalyzeThreads(target, desiredHackAmount);
        return sanitizeThreadCount(threads);
    } catch {
        return 0;
    }
}

function getAvailableThreads(ns, host, scriptRam, reserveHomeRam) {
    if (scriptRam <= 0) return 0;

    const maxRam = ns.getServerMaxRam(host);
    const usedRam = ns.getServerUsedRam(host);
    let usableRam = maxRam - usedRam;

    if (host === "home") {
        usableRam -= reserveHomeRam;
    }

    return Math.max(0, Math.floor(usableRam / scriptRam));
}

function allocateThreadsAcrossFleet(ns, hosts, script, target, neededThreads, version, opts) {
    const scriptRam = ns.getScriptRam(script, "home");
    if (scriptRam <= 0 || neededThreads <= 0) {
        clearUnneededWorkers(ns, hosts, script, target, version, new Set());
        return { allocatedThreads: 0 };
    }

    const hostStates = hosts
        .map(host => buildHostState(ns, host, script, target, version, scriptRam, opts.reserveHomeRam))
        .sort((a, b) => b.capacity - a.capacity || a.host.localeCompare(b.host));

    const keepHosts = new Set();
    let remainingThreads = neededThreads;
    let allocatedThreads = 0;

    // First count already-correct workers so the controller behaves like a scheduler, not a reset loop.
    for (const state of hostStates) {
        if (!state.correctProcess) continue;

        const keptThreads = Math.min(state.currentThreads, remainingThreads);
        if (keptThreads > 0) {
            keepHosts.add(state.host);
            allocatedThreads += keptThreads;
            remainingThreads -= keptThreads;
        }
    }

    // Then fill the gap with the largest free hosts until the requirement is satisfied.
    for (const state of hostStates) {
        if (remainingThreads <= 0) break;
        if (keepHosts.has(state.host)) continue;

        const allocatableThreads = state.correctProcess
            ? 0
            : Math.min(state.capacity, remainingThreads);

        if (allocatableThreads < 1) continue;

        replaceManagedWorkers(ns, state.host, script, target, version);
        const pid = ns.exec(script, state.host, allocatableThreads, target, version);
        if (pid !== 0) {
            keepHosts.add(state.host);
            allocatedThreads += allocatableThreads;
            remainingThreads -= allocatableThreads;
        }
    }

    clearUnneededWorkers(ns, hosts, script, target, version, keepHosts);

    return { allocatedThreads };
}

function buildHostState(ns, host, script, target, version, scriptRam, reserveHomeRam) {
    const processes = ns.ps(host).filter(proc => WORKER_SCRIPTS.includes(proc.filename));
    const correctProcess = processes.find(proc =>
        proc.filename === script &&
        String(proc.args[0] || "") === target &&
        String(proc.args[1] || "") === version
    ) || null;
    const otherManaged = processes.filter(proc => !correctProcess || proc.pid !== correctProcess.pid);
    const availableThreads = getAvailableThreads(ns, host, scriptRam, reserveHomeRam);
    const currentThreads = correctProcess ? Math.max(0, Number(correctProcess.threads) || 0) : 0;
    const hasConflicts = otherManaged.length > 0;
    const capacity = currentThreads > 0
        ? currentThreads + availableThreads
        : hasConflicts
            ? Math.floor((getManagedFreeableRam(ns, host) + getFreeRam(ns, host, reserveHomeRam)) / scriptRam)
            : availableThreads;

    return {
        host,
        correctProcess,
        currentThreads,
        capacity: Math.max(0, capacity),
    };
}

function clearUnneededWorkers(ns, hosts, script, target, version, keepHosts) {
    for (const host of hosts) {
        if (keepHosts.has(host)) {
            killConflictingWorkers(ns, host, script, target, version);
            continue;
        }

        killManagedWorkers(ns, host);
    }
}

function replaceManagedWorkers(ns, host, script, target, version) {
    killManagedWorkers(ns, host);
}

function killConflictingWorkers(ns, host, script, target, version) {
    for (const proc of ns.ps(host)) {
        if (!WORKER_SCRIPTS.includes(proc.filename)) continue;

        const matches = proc.filename === script &&
            String(proc.args[0] || "") === target &&
            String(proc.args[1] || "") === version;

        if (!matches) {
            ns.kill(proc.pid);
        }
    }
}

function killManagedWorkers(ns, host) {
    for (const proc of ns.ps(host)) {
        if (WORKER_SCRIPTS.includes(proc.filename)) {
            ns.kill(proc.pid);
        }
    }
}

function getManagedFreeableRam(ns, host) {
    let ram = 0;
    for (const proc of ns.ps(host)) {
        if (!WORKER_SCRIPTS.includes(proc.filename)) continue;
        ram += ns.getScriptRam(proc.filename, host) * (Number(proc.threads) || 0);
    }
    return ram;
}

function getFreeRam(ns, host, reserveHomeRam) {
    let freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (host === "home") {
        freeRam -= reserveHomeRam;
    }
    return Math.max(0, freeRam);
}

function getActionTime(ns, target, mode) {
    if (mode === "weaken") return ns.getWeakenTime(target);
    if (mode === "grow") return ns.getGrowTime(target);
    return ns.getHackTime(target);
}

function sanitizeThreadCount(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.ceil(value);
}

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

function formatMoney(ns, n) {
    return ns.formatNumber ? `$${ns.formatNumber(n, 2)}` : `$${Math.round(n)}`;
}

function formatDuration(ns, ms) {
    return ns.tFormat ? ns.tFormat(ms) : `${Math.round(ms)}ms`;
}
