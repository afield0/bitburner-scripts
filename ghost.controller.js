import {
    VERSION,
    WORKER_SCRIPTS,
    ALL_SCRIPTS,
    DECOMMISSION_FILE,
    SHARE_ENABLE_FILE,
    SILENT_ENABLE_FILE,
    XP_ENABLE_FILE,
    RESERVED_HOME_RAM,
    SECURITY_BUFFER,
    MONEY_THRESHOLD,
    HACK_MONEY_FRACTION,
    MONEY_TARGET_LIMIT,
    XP_TARGET_LIMIT,
    CONTROLLER_INTERVAL
} from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["interval", CONTROLLER_INTERVAL],
        ["once", false],
        ["target", ""],
        ["verbose", "true"],
        ["reserve-home-ram", RESERVED_HOME_RAM],
        ["hack-percent", HACK_MONEY_FRACTION],
        ["max-targets", 0],
    ]);

    disableLogs(ns);

    if (!ensureSingleController(ns)) {
        return;
    }

    let cycle = 0;

    while (true) {
        cycle += 1;
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

        const decommissionedHosts = getDecommissionedHosts(ns);
        const schedulableHosts = rooted.filter(host => !decommissionedHosts.has(host));
        const silent = shouldSilenceOutput(ns);
        const xpMode = shouldPrioritizeXp(ns);
        const planner = detectPlanner(ns);
        const verboseThisCycle = parseBooleanFlag(flags.verbose, true) && !silent && cycle % 3 === 1;

        const targets = flags.target
            ? [String(flags.target)]
            : getCandidateTargets(ns, network, xpMode, planner);

        if (targets.length === 0) {
            if (verboseThisCycle) {
                ns.tprint(`[GHOST ${VERSION}] No suitable target found. The studio is dark.`);
            }
        } else {
            const result = scheduleFleet(ns, schedulableHosts, targets, {
                verbose: verboseThisCycle,
                reserveHomeRam: Number(flags["reserve-home-ram"]),
                hackPercent: Number(flags["hack-percent"]),
                xpMode,
                maxTargets: Number(flags["max-targets"]),
                planner,
            });

            if (verboseThisCycle) {
                ns.tprint(
                    `[GHOST ${VERSION}] Broadcast complete. rooted=${rooted.length} schedulable=${schedulableHosts.length} decomm=${decommissionedHosts.size} targets=${result.summaries.length} allocated=${result.totalAllocatedThreads} goal=${xpMode ? "xp" : "money"} planner=${planner}`
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
        "getServer",
        "getPlayer",
        "getScriptRam",
        "weakenAnalyze",
        "growthAnalyze",
        "growthAnalyzeSecurity",
        "hackAnalyzeThreads",
        "hackAnalyzeSecurity",
        "getWeakenTime",
        "getGrowTime",
        "getHackTime",
        "share",
        "read",
    ].forEach(fn => ns.disableLog(fn));
}

function getDecommissionedHosts(ns) {
    if (!ns.fileExists(DECOMMISSION_FILE, "home")) {
        return new Set();
    }

    return new Set(
        ns.read(DECOMMISSION_FILE)
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean)
    );
}

function shouldSilenceOutput(ns) {
    return ns.fileExists(SILENT_ENABLE_FILE, "home");
}

function shouldPrioritizeXp(ns) {
    return ns.fileExists(XP_ENABLE_FILE, "home");
}

function detectPlanner(ns) {
    return hasFormulasAccess(ns) ? "formulas" : "basic";
}

function hasFormulasAccess(ns) {
    return ns.fileExists("Formulas.exe", "home") && Boolean(ns.formulas?.hacking);
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

function getCandidateTargets(ns, hosts, xpMode, planner) {
    const candidates = hosts.filter(host => {
        if (host === "home") return false;
        if (!ns.hasRootAccess(host)) return false;
        if (ns.getServerMaxMoney(host) <= 0) return false;
        if (ns.getServerRequiredHackingLevel(host) > ns.getHackingLevel()) return false;
        return true;
    });

    candidates.sort((a, b) => scoreTarget(ns, b, xpMode, planner) - scoreTarget(ns, a, xpMode, planner));
    return candidates;
}

function scoreTarget(ns, host, xpMode, planner) {
    if (xpMode) {
        return planner === "formulas"
            ? scoreTargetForXpFormulas(ns, host)
            : scoreTargetForXp(ns, host);
    }

    if (planner === "formulas") {
        return scoreTargetForMoneyFormulas(ns, host);
    }

    const maxMoney = ns.getServerMaxMoney(host);
    const minSec = ns.getServerMinSecurityLevel(host);
    const chance = ns.hackAnalyzeChance ? ns.hackAnalyzeChance(host) : 1;
    return (maxMoney * chance) / Math.max(1, minSec);
}

function scoreTargetForXp(ns, host) {
    const reqLevel = Math.max(1, ns.getServerRequiredHackingLevel(host));
    const playerLevel = Math.max(1, ns.getHackingLevel());
    const time = Math.max(1, ns.getWeakenTime(host));
    const levelFit = Math.min(1, reqLevel / playerLevel);
    return (levelFit * reqLevel) / time;
}

function scoreTargetForXpFormulas(ns, host) {
    try {
        const player = ns.getPlayer();
        const current = ns.getServer(host);
        const prepped = getPreppedServer(ns, host);
        const currentExp = Math.max(0, ns.formulas.hacking.hackExp(current, player));
        const preppedExp = Math.max(0, ns.formulas.hacking.hackExp(prepped, player));
        const currentTime = Math.max(1, ns.formulas.hacking.weakenTime(current, player));
        const preppedTime = Math.max(1, ns.formulas.hacking.weakenTime(prepped, player));
        return Math.max(currentExp / currentTime, preppedExp / preppedTime);
    } catch {
        return scoreTargetForXp(ns, host);
    }
}

function scoreTargetForMoneyFormulas(ns, host) {
    try {
        const player = ns.getPlayer();
        const current = ns.getServer(host);
        const prepped = getPreppedServer(ns, host);
        const currentScore = getFormulaMoneyRate(ns, current, player);
        const preppedScore = getFormulaMoneyRate(ns, prepped, player);
        const prepRatio = getPrepReadiness(current);
        return Math.max(currentScore, preppedScore * (0.25 + (0.75 * prepRatio)));
    } catch {
        return scoreTarget(ns, host, false, "basic");
    }
}

function getFormulaMoneyRate(ns, server, player) {
    const chance = Math.max(0, ns.formulas.hacking.hackChance(server, player));
    const percent = Math.max(0, ns.formulas.hacking.hackPercent(server, player));
    const time = Math.max(1, ns.formulas.hacking.hackTime(server, player));
    const money = Math.max(0, Number(server.moneyAvailable) || 0);
    return (money * chance * percent) / time;
}

function getPrepReadiness(server) {
    const moneyMax = Math.max(1, Number(server.moneyMax) || 1);
    const moneyAvailable = Math.max(0, Number(server.moneyAvailable) || 0);
    const minDifficulty = Math.max(1, Number(server.minDifficulty) || 1);
    const hackDifficulty = Math.max(minDifficulty, Number(server.hackDifficulty) || minDifficulty);
    const moneyRatio = Math.min(1, moneyAvailable / moneyMax);
    const securityRatio = Math.min(1, minDifficulty / hackDifficulty);
    return moneyRatio * securityRatio;
}

function getPreppedServer(ns, host) {
    const server = ns.getServer(host);
    server.moneyAvailable = server.moneyMax;
    server.hackDifficulty = server.minDifficulty;
    return server;
}

function getTargetLimit(xpMode, maxTargets) {
    const numeric = Number(maxTargets);
    if (Number.isFinite(numeric) && numeric > 0) {
        return Math.floor(numeric);
    }

    return xpMode ? XP_TARGET_LIMIT : MONEY_TARGET_LIMIT;
}

function getModePriority(mode, xpMode) {
    if (xpMode) {
        if (mode === "weaken") return 3;
        if (mode === "grow") return 2;
        return 1;
    }

    if (mode === "hack") return 3;
    if (mode === "grow") return 2;
    return 1;
}

function scheduleFleet(ns, rootedHosts, targets, opts) {
    const targetPlans = buildTargetPlans(ns, targets, opts.hackPercent, opts.xpMode, opts.maxTargets, opts.planner);
    const result = allocateTargetsAcrossFleet(ns, rootedHosts, targetPlans, VERSION, opts);
    result.shareEnabled = shouldRunSharing(ns);

    if (result.shareEnabled) {
        result.shareThreads = allocateSharingAcrossFleet(ns, rootedHosts, result.availableRam, result.desiredAssignments, VERSION);
    } else {
        result.shareThreads = 0;
    }

    if (opts.verbose) {
        for (const summary of result.summaries) {
            ns.tprint(
                `[GHOST ${VERSION}] Signal locked. target=${summary.target} mode=${summary.mode} needed=${summary.neededThreads} allocated=${summary.allocatedThreads} leftover=${summary.leftoverThreads} eta=${formatDuration(ns, summary.actionTime)} sec=${summary.security.toFixed(2)}/${summary.minSecurity.toFixed(2)} money=${formatMoney(ns, summary.money)}/${formatMoney(ns, summary.maxMoney)}`
            );
        }

        if (result.shareEnabled) {
            ns.tprint(`[GHOST ${VERSION}] Chorus online. mode=share allocated=${result.shareThreads} file=${SHARE_ENABLE_FILE}`);
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

function getNeededThreadsForMode(ns, target, mode, hackFraction, planner) {
    if (mode === "weaken") {
        return getNeededWeakenThreads(ns, target);
    }

    if (mode === "grow") {
        return planner === "formulas"
            ? getNeededGrowThreadsFormulas(ns, target)
            : getNeededGrowThreads(ns, target);
    }

    return planner === "formulas"
        ? getNeededHackThreadsFormulas(ns, target, hackFraction)
        : getNeededHackThreads(ns, target, hackFraction);
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

function getNeededGrowThreadsFormulas(ns, target) {
    try {
        const player = ns.getPlayer();
        const server = ns.getServer(target);
        const moneyMax = Number(server.moneyMax) || 0;
        const moneyAvailable = Number(server.moneyAvailable) || 0;

        if (moneyMax <= 0 || moneyAvailable >= moneyMax) {
            return 0;
        }

        const threads = ns.formulas.hacking.growThreads(server, player, moneyMax, 1);
        return sanitizeThreadCount(threads);
    } catch {
        return getNeededGrowThreads(ns, target);
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

function getNeededHackThreadsFormulas(ns, target, hackFraction) {
    try {
        const player = ns.getPlayer();
        const server = ns.getServer(target);
        const maxMoney = Number(server.moneyMax) || 0;
        const moneyAvailable = Math.max(1, Number(server.moneyAvailable) || 0);
        const fraction = clampNumber(hackFraction, 0.01, 0.99, HACK_MONEY_FRACTION);

        if (maxMoney <= 0) {
            return 0;
        }

        const percent = Math.max(0, ns.formulas.hacking.hackPercent(server, player));
        if (percent <= 0) {
            return 0;
        }

        const desiredHackAmount = Math.min(moneyAvailable, Math.max(1, maxMoney * fraction));
        return sanitizeThreadCount(desiredHackAmount / (moneyAvailable * percent));
    } catch {
        return getNeededHackThreads(ns, target, hackFraction);
    }
}

function buildTargetPlans(ns, targets, hackPercent, xpMode, maxTargets, planner) {
    const seen = new Set();
    const plans = [];
    const primaryTargetLimit = getTargetLimit(xpMode, maxTargets);
    let targetIndex = 0;

    for (const target of targets) {
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const isPrimaryTarget = primaryTargetLimit <= 0 || targetIndex < primaryTargetLimit;
        targetIndex += 1;

        const mode = selectMode(ns, target);
        const script = getWorkerScript(mode);
        const neededThreads = getNeededThreadsForMode(ns, target, mode, hackPercent, planner);

        if (neededThreads < 1) continue;

        const score = scoreTarget(ns, target, xpMode, planner);
        const primaryPriority = getModePriority(mode, xpMode) + (isPrimaryTarget ? 100 : 0);
        const weakenSupportThreads = getWeakenSupportThreads(ns, target, mode, neededThreads);

        if (weakenSupportThreads > 0) {
            plans.push(makePlan(ns, target, "weaken", weakenSupportThreads, primaryPriority + 1, score));
        }

        plans.push(makePlan(ns, target, mode, neededThreads, primaryPriority, score));
    }

    return plans.sort((a, b) =>
        b.modePriority - a.modePriority ||
        b.score - a.score ||
        a.actionTime - b.actionTime ||
        a.target.localeCompare(b.target)
    );
}

function makePlan(ns, target, mode, neededThreads, modePriority, score) {
    return {
        target,
        mode,
        script: getWorkerScript(mode),
        neededThreads,
        modePriority,
        score,
        actionTime: getActionTime(ns, target, mode),
        security: ns.getServerSecurityLevel(target),
        minSecurity: ns.getServerMinSecurityLevel(target),
        money: ns.getServerMoneyAvailable(target),
        maxMoney: ns.getServerMaxMoney(target),
    };
}

function getWeakenSupportThreads(ns, target, mode, primaryThreads) {
    if (primaryThreads < 1 || mode === "weaken") {
        return 0;
    }

    let securityIncrease = 0;

    try {
        if (mode === "hack" && ns.hackAnalyzeSecurity) {
            securityIncrease = ns.hackAnalyzeSecurity(primaryThreads, target);
        } else if (mode === "grow" && ns.growthAnalyzeSecurity) {
            securityIncrease = ns.growthAnalyzeSecurity(primaryThreads, target, 1);
        }
    } catch {
        securityIncrease = 0;
    }

    if (securityIncrease <= 0) {
        securityIncrease = mode === "hack" ? primaryThreads * 0.002 : primaryThreads * 0.004;
    }

    const weakenPerThread = Math.max(0, ns.weakenAnalyze(1, 1));
    if (weakenPerThread <= 0) {
        return 0;
    }

    return Math.ceil(securityIncrease / weakenPerThread);
}

function allocateTargetsAcrossFleet(ns, hosts, targetPlans, version, opts) {
    const hostOrder = hosts
        .slice()
        .sort((a, b) => getFreeRam(ns, b, opts.reserveHomeRam) - getFreeRam(ns, a, opts.reserveHomeRam) || a.localeCompare(b));
    const availableRam = new Map(hostOrder.map(host => [host, getFreeRam(ns, host, opts.reserveHomeRam)]));
    const desiredAssignments = new Map(hostOrder.map(host => [host, []]));
    const summaries = [];
    let totalAllocatedThreads = 0;

    for (const plan of targetPlans) {
        const existingEffectUnits = getExistingPlanEquivalentUnits(ns, hostOrder, plan, version);
        const remainingNeededThreads = Math.max(0, plan.neededThreads - existingEffectUnits);
        const plannedWork = {
            ...plan,
            neededThreads: remainingNeededThreads,
        };
        const distribution = allocatePlanAcrossHosts(ns, hostOrder, availableRam, plannedWork);

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
            existingThreads: existingEffectUnits,
            allocatedThreads: distribution.allocatedThreads,
            leftoverThreads: Math.max(0, remainingNeededThreads - distribution.allocatedThreads),
        });
        totalAllocatedThreads += distribution.allocatedThreads;
    }

    launchFleetAssignments(ns, hostOrder, desiredAssignments);

    return { summaries, totalAllocatedThreads, availableRam, desiredAssignments };
}

function shouldRunSharing(ns) {
    return ns.fileExists(SHARE_ENABLE_FILE, "home");
}

function allocateSharingAcrossFleet(ns, hosts, availableRam, desiredAssignments, version) {
    const script = "ghost.share.js";
    const scriptRam = ns.getScriptRam(script, "home");
    if (scriptRam <= 0) {
        return 0;
    }

    let totalThreads = 0;

    for (const host of hosts) {
        const freeRam = availableRam.get(host) || 0;
        const threads = Math.max(0, Math.floor(freeRam / scriptRam));
        if (threads < 1) continue;

        desiredAssignments.get(host).push({
            script,
            target: "share",
            version,
            threads,
        });
        totalThreads += threads;
        availableRam.set(host, Math.max(0, freeRam - (threads * scriptRam)));
    }

    launchFleetAssignments(ns, hosts, desiredAssignments);

    return totalThreads;
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
            effectPerThread: getPlanThreadEffectUnits(ns, host, plan),
        }))
        .filter(state => state.capacity > 0 && state.effectPerThread > 0)
        .sort((a, b) =>
            (b.capacity * b.effectPerThread) - (a.capacity * a.effectPerThread) ||
            b.effectPerThread - a.effectPerThread ||
            a.host.localeCompare(b.host)
        );
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
    let remainingUnits = neededThreads;

    for (let i = 0; i < usableHosts.length; i++) {
        const state = usableHosts[i];
        const maxUnits = state.capacity * state.effectPerThread;
        const assignedThreads = Math.min(
            state.capacity,
            Math.max(1, Math.ceil(remainingUnits / state.effectPerThread))
        );

        if (assignedThreads > 0 && maxUnits > 0) {
            plan.set(state.host, assignedThreads);
            remainingUnits = Math.max(0, remainingUnits - (assignedThreads * state.effectPerThread));
        }

        if (remainingUnits <= 0) {
            break;
        }
    }

    if (remainingUnits > 0) {
        for (const state of usableHosts) {
            if (remainingUnits <= 0) break;

            const currentAssigned = plan.get(state.host) || 0;
            const extraCapacity = state.capacity - currentAssigned;
            if (extraCapacity <= 0) continue;

            const extraThreads = Math.min(
                extraCapacity,
                Math.max(1, Math.ceil(remainingUnits / state.effectPerThread))
            );
            plan.set(state.host, currentAssigned + extraThreads);
            remainingUnits = Math.max(0, remainingUnits - (extraThreads * state.effectPerThread));
        }
    }

    return plan;
}

function launchFleetAssignments(ns, hosts, desiredAssignments) {
    for (const host of hosts) {
        launchHostAssignments(ns, host, desiredAssignments.get(host) || []);
    }
}

function launchHostAssignments(ns, host, desired) {
    const existing = ns.ps(host).filter(proc => WORKER_SCRIPTS.includes(proc.filename));
    const existingByKey = new Set();

    for (const proc of existing) {
        existingByKey.add(makeAssignmentKey({
            script: proc.filename,
            target: String(proc.args[0] || ""),
            version: String(proc.args[1] || ""),
            threads: Number(proc.threads) || 0,
        }));
    }

    for (const assignment of desired) {
        const key = makeAssignmentKey(assignment);
        if (existingByKey.has(key)) continue;
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

function makeAssignmentGroupKey(assignment) {
    return [
        assignment.script,
        assignment.target,
        assignment.version,
    ].join("|");
}

function getExistingPlanEquivalentUnits(ns, hosts, plan, version) {
    let units = 0;
    for (const host of hosts) {
        for (const proc of ns.ps(host)) {
            if (!WORKER_SCRIPTS.includes(proc.filename)) continue;
            if (String(proc.args[1] || "") !== version) continue;
            if (proc.filename !== plan.script) continue;
            if (String(proc.args[0] || "") !== plan.target) continue;
            units += (Number(proc.threads) || 0) * getPlanThreadEffectUnits(ns, host, plan);
        }
    }
    return units;
}

function getFreeRam(ns, host, reserveHomeRam) {
    let freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (host === "home") {
        freeRam -= reserveHomeRam;
    }
    return Math.max(0, freeRam);
}

function getActionTime(ns, target, mode) {
    if (hasFormulasAccess(ns)) {
        try {
            const player = ns.getPlayer();
            const server = ns.getServer(target);
            if (mode === "weaken") return ns.formulas.hacking.weakenTime(server, player);
            if (mode === "grow") return ns.formulas.hacking.growTime(server, player);
            return ns.formulas.hacking.hackTime(server, player);
        } catch {}
    }

    if (mode === "weaken") return ns.getWeakenTime(target);
    if (mode === "grow") return ns.getGrowTime(target);
    return ns.getHackTime(target);
}

function getPlanThreadEffectUnits(ns, host, plan) {
    if (plan.mode === "hack") {
        return 1;
    }

    const cores = getHostCpuCores(ns, host);
    if (plan.mode === "weaken") {
        const baseWeaken = Math.max(0, ns.weakenAnalyze(1, 1));
        const hostWeaken = Math.max(0, ns.weakenAnalyze(1, cores));
        return baseWeaken > 0 ? hostWeaken / baseWeaken : 1;
    }

    if (plan.mode === "grow") {
        const multiplier = getGrowMultiplier(ns, plan.target);
        if (multiplier <= 1) {
            return 1;
        }

        try {
            const baseThreads = ns.growthAnalyze(plan.target, multiplier, 1);
            const hostThreads = ns.growthAnalyze(plan.target, multiplier, cores);
            if (Number.isFinite(baseThreads) && Number.isFinite(hostThreads) && baseThreads > 0 && hostThreads > 0) {
                return baseThreads / hostThreads;
            }
        } catch {}
    }

    return 1;
}

function getHostCpuCores(ns, host) {
    try {
        const server = ns.getServer(host);
        return Math.max(1, Number(server.cpuCores) || 1);
    } catch {
        return 1;
    }
}

function getGrowMultiplier(ns, target) {
    const currentMoney = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    if (maxMoney <= 0 || currentMoney >= maxMoney) {
        return 1;
    }

    return Math.max(1, maxMoney / Math.max(1, currentMoney));
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

function parseBooleanFlag(value, fallback) {
    if (typeof value === "boolean") return value;

    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
    if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
    return fallback;
}

function formatMoney(ns, n) {
    return ns.formatNumber ? `$${ns.formatNumber(n, 2)}` : `$${Math.round(n)}`;
}

function formatDuration(ns, ms) {
    return ns.tFormat ? ns.tFormat(ms) : `${Math.round(ms)}ms`;
}
