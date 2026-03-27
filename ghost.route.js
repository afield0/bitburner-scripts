/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["target", ""],
        ["cmd", false],
    ]);

    disableLogs(ns);

    const target = String(flags.target || ns.args[0] || "").trim();
    if (!target) {
        ns.tprint("Usage: run ghost.route.js --target <host>");
        return;
    }

    const network = discoverNetwork(ns, "home");
    if (!network.parents.has(target) && target !== "home") {
        ns.tprint(`[ROUTE] Target not found: ${target}`);
        return;
    }

    const path = buildPath(target, network.parents);
    const hops = Math.max(0, path.length - 1);
    const route = path.join(" -> ");
    const connectCommand = path.slice(1).map(host => `connect ${host};`).join(" ");

    ns.tprint(`[ROUTE] target=${target} hops=${hops}`);
    ns.tprint(`[ROUTE] path=${route}`);
    ns.tprint(`[ROUTE] cmd=${connectCommand || "home"}`);

    if (Boolean(flags.cmd)) {
        ns.tprint(connectCommand || "home");
    }
}

function discoverNetwork(ns, start) {
    const visited = new Set();
    const queue = [start];
    const parents = new Map([[start, ""]]);

    while (queue.length > 0) {
        const host = queue.shift();
        if (visited.has(host)) continue;
        visited.add(host);

        for (const neighbor of ns.scan(host).sort()) {
            if (!parents.has(neighbor)) {
                parents.set(neighbor, host);
            }
            if (!visited.has(neighbor)) {
                queue.push(neighbor);
            }
        }
    }

    return { parents };
}

function buildPath(target, parents) {
    const path = [];
    let current = target;

    while (current) {
        path.push(current);
        current = parents.get(current) || "";
    }

    return path.reverse();
}

function disableLogs(ns) {
    [
        "scan",
    ].forEach(fn => ns.disableLog(fn));
}
