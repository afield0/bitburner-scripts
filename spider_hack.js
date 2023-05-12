/** @param {NS} ns */

var scanned_hosts = [];
var programs = ['BruteSSH.exe', 'relaySMTP.exe', 'FTPCrack.exe', 'HTTPWorm.exe', 'SQLInject.exe'];
var program_pointers = [];

export async function scanit(ns, host, port_level) {
	let adj_hosts = ns.scan(host)
	for (let i=0;i<adj_hosts.length;i++) {
		let adj_host = adj_hosts[i];
		if (scanned_hosts.indexOf(adj_host) == -1) {
			scanned_hosts.push(adj_host)
			scanit(ns, adj_host, port_level);
			if (
					!ns.hasRootAccess(adj_host)
					&& 
					ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(adj_host)
					&& 
					port_level >= ns.getServerNumPortsRequired(adj_host)
				)
			{
				ns.tprintf("Hacking `%s`...",adj_host);
				for (let p=0;p < ns.getServerNumPortsRequired(adj_host);p++) {
					ns.tprintf("---- Running %s against host...", programs[p]);
					program_pointers[p](adj_host);
				}
				ns.tprintf("---- NUKED!");
				ns.nuke(adj_host);
			}
		}

	}

}

export async function main(ns) {
	program_pointers = [ns.brutessh, ns.relaysmtp, ns.ftpcrack, ns.httpworm, ns.sqlinject];
	ns.tprintf("This script needs %dGB of RAM.", ns.getScriptRam(ns.getScriptName()));
	let port_level = 0;
	for (let i=0;i<programs.length;i++) {
		if (ns.fileExists(programs[i])) {
			port_level++;
		} else {
			programs[i] = null; 
			program_pointers[i] = null;
		}
	}
	program_pointers = program_pointers.filter(element => { return element !== null; });	
	programs = programs.filter(element => { return element !== null; });	
	ns.tprintf("You can open %d port(s).", port_level)
	scanit(ns, "home", port_level);
	for (let i=0;i<scanned_hosts.length;i++) {
		if (scanned_hosts[i] != "home" && ns.hasRootAccess(scanned_hosts[i])) {
			ns.tprintf("Copying payload to %s...", scanned_hosts[i]);
			await ns.scp(ns.ls('home', '/payload'), scanned_hosts[i]);
		}
	}
}