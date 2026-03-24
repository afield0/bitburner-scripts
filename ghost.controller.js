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
            deployFleet(ns, rooted, target, {
                verbose: flags.verbose,
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

function deployFleet(ns, rootedHosts, target, opts) {
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    let workerScript;

    if (security > minSecurity + SECURITY_BUFFER) {
        workerScript = "ghost.weaken.js";
    } else if (money < maxMoney * MONEY_THRESHOLD) {
        workerScript = "ghost.grow.js";
    } else {
        workerScript = "ghost.hack.js";
    }

    for (const host of rootedHosts) {
        runWorkerMax(ns, host, workerScript, target, opts);
    }

    if (opts.verbose) {
        ns.tprint(
            `[GHOST ${VERSION}] Cue the signal. mode=${workerScript} target=${target} sec=${security.toFixed(2)}/${minSecurity.toFixed(2)} money=${formatMoney(ns, money)}/${formatMoney(ns, maxMoney)}`
        );
    }
}

function runWorkerMax(ns, host, script, target, opts) {
    const scriptRam = ns.getScriptRam(script, host);
    if (scriptRam <= 0) return;

    const maxRam = ns.getServerMaxRam(host);
    const usedRam = ns.getServerUsedRam(host);

    let usableRam = maxRam - usedRam;

    if (host === "home") {
        usableRam -= opts.reserveHomeRam;
    }

    const threads = Math.floor(usableRam / scriptRam);
    if (threads < 1) return;

    killManagedWorkers(ns, host);

    ns.exec(script, host, threads, target, VERSION);
}

function killManagedWorkers(ns, host) {
    for (const proc of ns.ps(host)) {
        if (WORKER_SCRIPTS.includes(proc.filename)) {
            ns.kill(proc.pid);
        }
    }
}

function formatMoney(ns, n) {
    return ns.formatNumber ? `$${ns.formatNumber(n, 2)}` : `$${Math.round(n)}`;
}