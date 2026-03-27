/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["dry-run", false],
        ["folder", "trophies"],
        ["force-files", false],
    ]);

    disableLogs(ns);

    const dryRun = Boolean(flags["dry-run"]);
    const folder = sanitizeFolder(String(flags.folder || "trophies"));
    const results = [];

    ensureScriptAchievements(ns, folder, Boolean(flags["force-files"]), dryRun, results);
    await attemptHacknetAchievement(ns, dryRun, results);
    await attemptTorAndPrograms(ns, dryRun, results);
    await attemptTravelWorkoutHospital(ns, dryRun, results);

    ns.tprint(`[TROPHIES] completed=${countResults(results, "done")} blocked=${countResults(results, "blocked")} info=${countResults(results, "info")} dryRun=${dryRun}`);
    for (const result of results) {
        ns.tprint(`[TROPHIES] ${result.status} achievement=${result.name} detail=${result.detail}`);
    }
}

function ensureScriptAchievements(ns, folder, forceFiles, dryRun, results) {
    const ns2Path = `${folder}/maximum_speed.js`;
    const heavyPath = `${folder}/upgrade_for_this_one.js`;
    const fillerPrefix = `${folder}/folder_${Date.now()}`;

    writeFileIfNeeded(ns, ns2Path, buildNs2Script(), forceFiles, dryRun, results, "Maximum speed!", "created ns2 script");
    writeFileIfNeeded(ns, heavyPath, buildHeavyScript(), forceFiles, dryRun, results, "You'll need upgrade for this one.", "created high-ram script target");

    const currentScripts = ns.ls("home", ".js").length;
    if (currentScripts >= 30) {
        results.push({
            status: "info",
            name: "Thank you folders!",
            detail: `already have ${currentScripts} .js files on home`,
        });
        return;
    }

    const needed = 30 - currentScripts;
    if (dryRun) {
        results.push({
            status: "done",
            name: "Thank you folders!",
            detail: `would create ${needed} filler scripts under ${folder}/`,
        });
        return;
    }

    for (let i = 0; i < needed; i++) {
        const path = `${fillerPrefix}_${i}.js`;
        ns.write(path, buildFillerScript(i), "w");
    }

    results.push({
        status: "done",
        name: "Thank you folders!",
        detail: `created ${needed} filler scripts under ${folder}/`,
    });
}

async function attemptHacknetAchievement(ns, dryRun, results) {
    const nodes = ns.hacknet.numNodes();
    if (nodes > 0) {
        results.push({
            status: "info",
            name: "Free money!",
            detail: `hacknet nodes already owned=${nodes}`,
        });
        return;
    }

    const cost = ns.hacknet.getPurchaseNodeCost();
    const cash = ns.getServerMoneyAvailable("home");
    if (cash < cost) {
        results.push({
            status: "blocked",
            name: "Free money!",
            detail: `need ${formatMoney(ns, cost)} but only have ${formatMoney(ns, cash)}`,
        });
        return;
    }

    if (dryRun) {
        results.push({
            status: "done",
            name: "Free money!",
            detail: `would purchase first hacknet node for ${formatMoney(ns, cost)}`,
        });
        return;
    }

    const index = ns.hacknet.purchaseNode();
    if (index >= 0) {
        results.push({
            status: "done",
            name: "Free money!",
            detail: `purchased hacknet-node-${index} for ${formatMoney(ns, cost)}`,
        });
        return;
    }

    results.push({
        status: "blocked",
        name: "Free money!",
        detail: "purchase failed unexpectedly",
    });
}

async function attemptTorAndPrograms(ns, dryRun, results) {
    const singularity = ns.singularity;
    if (!singularity) {
        results.push({
            status: "blocked",
            name: "The Onion Network / program achievements",
            detail: "Singularity access unavailable",
        });
        return;
    }

    const player = ns.getPlayer();
    const hasTor = Boolean(player.tor);
    if (hasTor) {
        results.push({
            status: "info",
            name: "The Onion Network",
            detail: "TOR already owned",
        });
    } else {
        const torCost = 200000;
        if (player.money < torCost) {
            results.push({
                status: "blocked",
                name: "The Onion Network",
                detail: `need ${formatMoney(ns, torCost)} but only have ${formatMoney(ns, player.money)}`,
            });
        } else if (dryRun) {
            results.push({
                status: "done",
                name: "The Onion Network",
                detail: `would purchase TOR for ${formatMoney(ns, torCost)}`,
            });
        } else if (singularity.purchaseTor()) {
            results.push({
                status: "done",
                name: "The Onion Network",
                detail: `purchased TOR for ${formatMoney(ns, torCost)}`,
            });
        } else {
            results.push({
                status: "blocked",
                name: "The Onion Network",
                detail: "purchaseTor() returned false",
            });
        }
    }

    for (const [program, achievement] of PROGRAM_ACHIEVEMENTS) {
        if (ns.fileExists(program, "home")) {
            results.push({
                status: "info",
                name: achievement,
                detail: `${program} already owned`,
            });
            continue;
        }

        if (!ns.getPlayer().tor) {
            results.push({
                status: "blocked",
                name: achievement,
                detail: `cannot buy ${program} without TOR`,
            });
            continue;
        }

        const cost = getDarkwebProgramCost(program);
        if (ns.getServerMoneyAvailable("home") < cost) {
            results.push({
                status: "blocked",
                name: achievement,
                detail: `need ${formatMoney(ns, cost)} for ${program}`,
            });
            continue;
        }

        if (dryRun) {
            results.push({
                status: "done",
                name: achievement,
                detail: `would purchase ${program} for ${formatMoney(ns, cost)}`,
            });
            continue;
        }

        if (singularity.purchaseProgram(program)) {
            results.push({
                status: "done",
                name: achievement,
                detail: `purchased ${program} for ${formatMoney(ns, cost)}`,
            });
        } else {
            results.push({
                status: "blocked",
                name: achievement,
                detail: `purchaseProgram(${program}) returned false`,
            });
        }
    }
}

async function attemptTravelWorkoutHospital(ns, dryRun, results) {
    const singularity = ns.singularity;
    if (!singularity) {
        results.push({
            status: "blocked",
            name: "World explorer / Gains! / Ouch!",
            detail: "Singularity access unavailable",
        });
        return;
    }

    const player = ns.getPlayer();
    const travelCity = CITIES.find(city => city !== player.city) || "";
    if (!travelCity) {
        results.push({
            status: "info",
            name: "World explorer",
            detail: `already in a valid city=${player.city}`,
        });
    } else {
        const travelCost = 200000;
        if (player.money < travelCost) {
            results.push({
                status: "blocked",
                name: "World explorer",
                detail: `need ${formatMoney(ns, travelCost)} to travel`,
            });
        } else if (dryRun) {
            results.push({
                status: "done",
                name: "World explorer",
                detail: `would travel from ${player.city} to ${travelCity}`,
            });
        } else if (singularity.travelToCity(travelCity)) {
            results.push({
                status: "done",
                name: "World explorer",
                detail: `traveled from ${player.city} to ${travelCity}`,
            });
        } else {
            results.push({
                status: "blocked",
                name: "World explorer",
                detail: `travelToCity(${travelCity}) returned false`,
            });
        }
    }

    const currentCity = ns.getPlayer().city;
    if (!GYMS[currentCity]) {
        results.push({
            status: "blocked",
            name: "Gains!",
            detail: `no supported gym configured for city=${currentCity}`,
        });
    } else if (dryRun) {
        results.push({
            status: "done",
            name: "Gains!",
            detail: `would start workout at ${GYMS[currentCity]} in ${currentCity}`,
        });
    } else if (singularity.gymWorkout(GYMS[currentCity], "str", false)) {
        await ns.sleep(100);
        singularity.stopAction();
        results.push({
            status: "done",
            name: "Gains!",
            detail: `started and stopped workout at ${GYMS[currentCity]}`,
        });
    } else {
        results.push({
            status: "blocked",
            name: "Gains!",
            detail: `gymWorkout(${GYMS[currentCity]}) returned false`,
        });
    }

    const hospitalCostEstimate = 100000;
    if (ns.getServerMoneyAvailable("home") < hospitalCostEstimate) {
        results.push({
            status: "blocked",
            name: "Ouch!",
            detail: `kept blocked to avoid hospital cost with only ${formatMoney(ns, ns.getServerMoneyAvailable("home"))}`,
        });
        return;
    }

    if (dryRun) {
        results.push({
            status: "done",
            name: "Ouch!",
            detail: "would call hospitalize()",
        });
        return;
    }

    try {
        singularity.hospitalize();
        results.push({
            status: "done",
            name: "Ouch!",
            detail: "called hospitalize()",
        });
    } catch (error) {
        results.push({
            status: "blocked",
            name: "Ouch!",
            detail: `hospitalize() failed: ${String(error)}`,
        });
    }
}

function writeFileIfNeeded(ns, path, contents, forceFiles, dryRun, results, name, actionText) {
    const exists = ns.fileExists(path, "home");
    if (exists && !forceFiles) {
        results.push({
            status: "info",
            name,
            detail: `${path} already exists`,
        });
        return;
    }

    if (dryRun) {
        results.push({
            status: "done",
            name,
            detail: `would write ${path} (${actionText})`,
        });
        return;
    }

    ns.write(path, contents, "w");
    results.push({
        status: "done",
        name,
        detail: `wrote ${path} (${actionText})`,
    });
}

function buildNs2Script() {
    return `/** @param {NS} ns **/
export async function main(ns) {
    ns.tprint("Achievement helper ns2 script.");
}
`;
}

function buildHeavyScript() {
    return `/** @param {NS} ns **/
export async function main(ns) {
    if (false) {
        ns.gang.inGang();
        ns.corporation.hasCorporation();
        ns.bladeburner.inBladeburner();
        ns.stock.has4SDataTIXAPI();
        ns.singularity.getOwnedAugmentations();
        ns.sleeve.getNumSleeves();
        ns.stanek.activeFragments();
        ns.codingcontract.getContractTypes();
        ns.hacknet.hashCapacity();
    }
    ns.tprint("Static RAM achievement helper.");
}
`;
}

function buildFillerScript(index) {
    return `/** @param {NS} ns **/
export async function main(ns) {
    ns.print("filler-${index}");
}
`;
}

function sanitizeFolder(folder) {
    const cleaned = folder.replace(/^\/+/, "").replace(/\/+$/, "");
    return cleaned || "trophies";
}

function countResults(results, status) {
    return results.filter(result => result.status === status).length;
}

function getDarkwebProgramCost(program) {
    if (program === "BruteSSH.exe") return 500000;
    if (program === "FTPCrack.exe") return 1500000;
    if (program === "relaySMTP.exe") return 5000000;
    if (program === "HTTPWorm.exe") return 30000000;
    if (program === "SQLInject.exe") return 250000000;
    if (program === "Formulas.exe") return 5000000000;
    return Number.POSITIVE_INFINITY;
}

function disableLogs(ns) {
    [
        "sleep",
        "write",
        "ls",
        "getServerMoneyAvailable",
        "fileExists",
    ].forEach(fn => ns.disableLog(fn));
}

function formatMoney(ns, amount) {
    return ns.formatNumber ? `$${ns.formatNumber(amount, 2)}` : `$${Math.round(amount)}`;
}

const PROGRAM_ACHIEVEMENTS = [
    ["BruteSSH.exe", "BruteSSH.exe"],
    ["FTPCrack.exe", "FTPCrack.exe"],
    ["relaySMTP.exe", "relaySMTP.exe"],
    ["HTTPWorm.exe", "HTTPWorm.exe"],
    ["SQLInject.exe", "SQLInject.exe"],
    ["Formulas.exe", "Formulas.exe"],
];

const CITIES = [
    "Sector-12",
    "Aevum",
    "Chongqing",
    "Ishima",
    "New Tokyo",
    "Volhaven",
];

const GYMS = {
    "Sector-12": "Powerhouse Gym",
    "Aevum": "Snap Fitness Gym",
    "Volhaven": "Millenium Fitness Gym",
};
