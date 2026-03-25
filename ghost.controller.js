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

    if (!ensureSingleController(ns)) {
        return;
    }

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

        const targets = flags.target
            ? [String(flags.target)]
            : getCandidateTargets(ns, network);

        if (targets.length === 0) {
            if (flags.verbose) {
                ns.tprint(`[GHOST ${VERSION}] No suitable target found. The studio is dark.`);
            }
        } else {
            const result = scheduleFleet(ns, rooted, targets, {
                verbose: Boolean(flags.verbose),
                reserveHomeRam: Number(flags["reserve-home-ram"]),
                hackPercent: Number(flags["hack-percent"]),
            });

            if (flags.verbose) {
                ns.tprint(
                    `[GHOST ${VERSION}] Broadcast complete. rooted=${rooted.length} targets=${result.summaries.length} allocated=${result.totalAllocatedThreads}`
                );
            }
        }

        if (flags.once) return;
        await ns.sleep(Number(flags.interval));
    }
}

function ensureSingleController(ns) {
    const controllers = ns.ps("home")
        .filter(proc => proc.filename === "ghost.controller.js")
        .sort((a, b) => a.pid - b.pid);
    const keeper = controllers[0] || null;

    if (!keeper) {
        return true;
    }

    if (keeper.pid !== ns.pid) {
        ns.tprint(`[GHOST ${VERSION}] Another bridge captain already holds the console. keeperPid=${keeper.pid} exitingPid=${ns.pid}`);
        return false;
    }

    for (const proc of controllers) {
        if (proc.pid === ns.pid) continue;
        ns.kill(proc.pid);
    }

    return true;
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
        "getHackingLevel",
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
    const currentPid = ns.pid;

    for (const proc of ns.ps(host)) {
        if (!isManagedScript(proc.filename)) continue;
        if (proc.pid === currentPid) continue;

        const procVersion = proc.args.length > 1
            ? String(proc.args[1])
            : proc.filename === "ghost.controller.js" && proc.args.length > 0
                ? String(proc.args[0])
                : "unknown";

        if (proc.filename === "ghost.controller.js" && procVersion === "unknown") {
            continue;
        }

        if (procVersion !== VERSION) {
            ns.kill(proc.pid);
        }
    }
}

function isManagedScript(filename) {
    return filename === "ghost.controller.js" || WORKER_SCRIPTS.includes(filename);
}

function getCandidateTargets(ns, hosts) {
    const candidates = hosts.filter(host => {
        if (host === "home") return false;
        if (!ns.hasRootAccess(host)) return false;
        if (ns.getServerMaxMoney(host) <= 0) return false;
        if (ns.getServerRequiredHackingLevel(host) > ns.getHackingLevel()) return false;
        return true;
    });

    candidates.sort((a, b) => scoreTarget(ns, b) - scoreTarget(ns, a));
    return candidates;
}

function scoreTarget(ns, host) {
    const maxMoney = ns.getServerMaxMoney(host);
    const minSec = ns.getServerMinSecurityLevel(host);
    const chance = ns.hackAnalyzeChance ? ns.hackAnalyzeChance(host) : 1;
    return (maxMoney * chance) / Math.max(1, minSec);
}

function getModePriority(mode) {
    if (mode === "hack") return 3;
    if (mode === "grow") return 2;
    return 1;
}

function scheduleFleet(ns, rootedHosts, targets, opts) {
    const targetPlans = buildTargetPlans(ns, targets, opts.hackPercent);
    const result = allocateTargetsAcrossFleet(ns, rootedHosts, targetPlans, VERSION, opts);

    if (opts.verbose) {
        for (const summary of result.summaries) {
            ns.tprint(
                `[GHOST ${VERSION}] Signal locked. target=${summary.target} mode=${summary.mode} needed=${summary.neededThreads} allocated=${summary.allocatedThreads} leftover=${summary.leftoverThreads} eta=${formatDuration(ns, summary.actionTime)} sec=${summary.security.toFixed(2)}/${summary.minSecurity.toFixed(2)} money=${formatMoney(ns, summary.money)}/${formatMoney(ns, summary.maxMoney)}`
            );
        }
    }

    return result;
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

function buildTargetPlans(ns, targets, hackPercent) {
    const seen = new Set();
    const plans = [];

    for (const target of targets) {
        if (!target || seen.has(target)) continue;
        seen.add(target);

        const mode = selectMode(ns, target);
        const script = getWorkerScript(mode);
        const neededThreads = getNeededThreadsForMode(ns, target, mode, hackPercent);

        if (neededThreads < 1) continue;

        plans.push({
            target,
            mode,
            script,
            neededThreads,
            modePriority: getModePriority(mode),
            score: scoreTarget(ns, target),
            actionTime: getActionTime(ns, target, mode),
            security: ns.getServerSecurityLevel(target),
            minSecurity: ns.getServerMinSecurityLevel(target),
            money: ns.getServerMoneyAvailable(target),
            maxMoney: ns.getServerMaxMoney(target),
        });
    }

    return plans.sort((a, b) =>
        b.modePriority - a.modePriority ||
        b.score - a.score ||
        a.actionTime - b.actionTime ||
        a.target.localeCompare(b.target)
    );
}

function allocateTargetsAcrossFleet(ns, hosts, targetPlans, version, opts) {
    const hostOrder = hosts
        .slice()
        .sort((a, b) => getFleetCapacityRam(ns, b, opts.reserveHomeRam) - getFleetCapacityRam(ns, a, opts.reserveHomeRam) || a.localeCompare(b));
    const availableRam = new Map(hostOrder.map(host => [host, getFleetCapacityRam(ns, host, opts.reserveHomeRam)]));
    const desiredAssignments = new Map(hostOrder.map(host => [host, []]));
    const summaries = [];
    let totalAllocatedThreads = 0;

    for (const plan of targetPlans) {
        const distribution = allocatePlanAcrossHosts(ns, hostOrder, availableRam, plan);

        for (const [host, threads] of distribution.hostThreads.entries()) {
            desiredAssignments.get(host).push({
                script: plan.script,
                target: plan.target,
                version,
                threads,
            });
        }

        summaries.push({
            ...plan,
            allocatedThreads: distribution.allocatedThreads,
            leftoverThreads: Math.max(0, plan.neededThreads - distribution.allocatedThreads),
        });
        totalAllocatedThreads += distribution.allocatedThreads;
    }

    reconcileFleetAssignments(ns, hostOrder, desiredAssignments);

    return { summaries, totalAllocatedThreads };
}

function allocatePlanAcrossHosts(ns, hostOrder, availableRam, plan) {
    const scriptRam = ns.getScriptRam(plan.script, "home");
    if (scriptRam <= 0 || plan.neededThreads <= 0) {
        return { allocatedThreads: 0, hostThreads: new Map() };
    }

    const hostStates = hostOrder
        .map(host => ({
            host,
            capacity: Math.max(0, Math.floor((availableRam.get(host) || 0) / scriptRam)),
        }))
        .filter(state => state.capacity > 0)
        .sort((a, b) => b.capacity - a.capacity || a.host.localeCompare(b.host));
    const desiredPlan = buildDistributedPlan(hostStates, plan.neededThreads);
    let allocatedThreads = 0;

    for (const [host, threads] of desiredPlan.entries()) {
        allocatedThreads += threads;
        availableRam.set(host, Math.max(0, (availableRam.get(host) || 0) - (threads * scriptRam)));
    }

    return { allocatedThreads, hostThreads: desiredPlan };
}

function buildDistributedPlan(hostStates, neededThreads) {
    const usableHosts = hostStates.filter(state => state.capacity > 0);
    const plan = new Map();
    let remainingThreads = neededThreads;

    for (let i = 0; i < usableHosts.length; i++) {
        const state = usableHosts[i];
        const hostsLeft = usableHosts.length - i;
        const fairShare = Math.max(1, Math.ceil(remainingThreads / hostsLeft));
        const assignedThreads = Math.min(state.capacity, fairShare, remainingThreads);

        if (assignedThreads > 0) {
            plan.set(state.host, assignedThreads);
            remainingThreads -= assignedThreads;
        }

        if (remainingThreads <= 0) {
            break;
        }
    }

    if (remainingThreads > 0) {
        for (const state of usableHosts) {
            if (remainingThreads <= 0) break;

            const currentAssigned = plan.get(state.host) || 0;
            const extraCapacity = state.capacity - currentAssigned;
            if (extraCapacity <= 0) continue;

            const extraThreads = Math.min(extraCapacity, remainingThreads);
            plan.set(state.host, currentAssigned + extraThreads);
            remainingThreads -= extraThreads;
        }
    }

    return plan;
}

function reconcileFleetAssignments(ns, hosts, desiredAssignments) {
    for (const host of hosts) {
        reconcileHostAssignments(ns, host, desiredAssignments.get(host) || []);
    }
}

function reconcileHostAssignments(ns, host, desired) {
    const existing = ns.ps(host).filter(proc => WORKER_SCRIPTS.includes(proc.filename));
    const desiredByKey = new Map();

    for (const assignment of desired) {
        desiredByKey.set(makeAssignmentKey(assignment), assignment);
    }

    for (const proc of existing) {
        const assignment = {
            script: proc.filename,
            target: String(proc.args[0] || ""),
            version: String(proc.args[1] || ""),
            threads: Number(proc.threads) || 0,
        };
        const key = makeAssignmentKey(assignment);

        if (desiredByKey.has(key)) {
            desiredByKey.delete(key);
            continue;
        }

        ns.kill(proc.pid);
    }

    for (const assignment of desiredByKey.values()) {
        ns.exec(assignment.script, host, assignment.threads, assignment.target, assignment.version);
    }
}

function makeAssignmentKey(assignment) {
    return [
        assignment.script,
        assignment.target,
        assignment.version,
        String(assignment.threads),
    ].join("|");
}

function getManagedFreeableRam(ns, host) {
    let ram = 0;
    for (const proc of ns.ps(host)) {
        if (!WORKER_SCRIPTS.includes(proc.filename)) continue;
        ram += ns.getScriptRam(proc.filename, host) * (Number(proc.threads) || 0);
    }
    return ram;
}

function getFleetCapacityRam(ns, host, reserveHomeRam) {
    return getFreeRam(ns, host, reserveHomeRam) + getManagedFreeableRam(ns, host);
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
