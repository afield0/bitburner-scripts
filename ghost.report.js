import {
    VERSION,
    WORKER_SCRIPTS,
    RESERVED_HOME_RAM
} from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["script", "ghost.weaken.js"],
        ["reserve-home-ram", RESERVED_HOME_RAM],
        ["all", false],
    ]);

    const script = String(flags.script || "ghost.weaken.js");
    const reserveHomeRam = Number(flags["reserve-home-ram"]);
    const showAll = Boolean(flags.all);

    disableLogs(ns);

    const hosts = discoverNetwork(ns, "home")
        .filter(host => ns.hasRootAccess(host))
        .sort((a, b) => {
            const freeDiff = getFreeRam(ns, b, reserveHomeRam) - getFreeRam(ns, a, reserveHomeRam);
            return freeDiff || a.localeCompare(b);
        });

    const scriptRam = ns.getScriptRam(script, "home");
    if (scriptRam <= 0) {
        ns.tprint(`[GHOST ${VERSION}] Signal lost. script=${script} has no readable RAM profile.`);
        return;
    }

    let totalAvailableThreads = 0;
    let totalGhostThreads = 0;
    let printed = 0;

    ns.tprint(`[GHOST ${VERSION}] Fleet census online. script=${script} ram=${formatRam(scriptRam)} reserveHome=${formatRam(reserveHomeRam)}`);

    for (const host of hosts) {
        const freeRam = getFreeRam(ns, host, reserveHomeRam);
        const availableThreads = Math.max(0, Math.floor(freeRam / scriptRam));
        const ghostProcesses = ns.ps(host).filter(proc => WORKER_SCRIPTS.includes(proc.filename));
        const ghostThreads = ghostProcesses.reduce((sum, proc) => sum + (Number(proc.threads) || 0), 0);

        totalAvailableThreads += availableThreads;
        totalGhostThreads += ghostThreads;

        if (!showAll && availableThreads === 0 && ghostThreads === 0) {
            continue;
        }

        printed += 1;
        const active = ghostProcesses.length > 0
            ? ghostProcesses
                .map(proc => `${proc.filename} x${proc.threads} -> ${String(proc.args[0] || "none")} [${String(proc.args[1] || "unknown")}]`)
                .join(" | ")
            : "quiet vacuum";

        ns.tprint(
            `[GHOST ${VERSION}] host=${host} free=${formatRam(freeRam)} availThreads=${availableThreads} ghostThreads=${ghostThreads} active=${active}`
        );
    }

    ns.tprint(
        `[GHOST ${VERSION}] Fleet census complete. hosts=${hosts.length} shown=${printed} totalAvailThreads=${totalAvailableThreads} totalGhostThreads=${totalGhostThreads}`
    );
}

function disableLogs(ns) {
    [
        "scan",
        "ps",
        "hasRootAccess",
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

    return result;
}

function getFreeRam(ns, host, reserveHomeRam) {
    let freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (host === "home") {
        freeRam -= reserveHomeRam;
    }
    return Math.max(0, freeRam);
}

function formatRam(ram) {
    return `${ram.toFixed(2)}GB`;
}
