# bitburner-scripts
My own Bitburner scripts

## Market scripts

`market.4s.js` is a 4S-only stock trader. It requires WSE, TIX, 4S Market Data, and 4S TIX API access. The first version is long-only and uses forecast thresholds with reserve-cash and per-position caps.

Run it with:

```text
run market.4s.js
run market.4s.js --once
run market.4s.js --reserve-cash 50m --max-position-ratio 0.15
```

Supported flags:

- `--once`: run one trading pass and exit.
- `--interval <ms>`: delay between trading passes.
- `--reserve-cash <amount>`: cash to keep untouched on `home`. Supports suffixes like `k`, `m`, `b`, and `t`.
- `--max-position-ratio <0-1>`: maximum fraction of total equity to place into one symbol.
- `--buy-forecast <0.5-0.99>`: minimum forecast to open a position.
- `--sell-forecast <0.5-0.99>`: forecast threshold to exit a position.
- `--min-volatility <n>`: ignore symbols below this volatility.
- `--max-holdings <n>`: cap the number of concurrent long positions.
- `--verbose <true|false>`: control per-pass status output.

## Ghost scripts

`ghost.controller.js` is the fleet coordinator. It scans the network, roots hosts, syncs the ghost scripts, selects targets, and assigns `hack`, `grow`, `weaken`, and optional `share` work across available RAM.

Run it with:

```text
run ghost.controller.js
run ghost.controller.js --target n00dles
run ghost.controller.js --hack-percent 0.05
```

Supported controller flags:

- `--interval <ms>`: polling interval between controller passes.
- `--once`: run one scheduling pass and exit.
- `--target <host>`: force a specific target instead of auto-selection.
- `--verbose <true|false>`: control periodic status output.
- `--reserve-home-ram <gb>`: keep RAM free on `home`.
- `--hack-percent <0-1>`: fraction of target max money to steal per hack plan.

### File toggles

`ghost.toggle.js` manages file-based directives on `home`.

```text
run ghost.toggle.js status share
run ghost.toggle.js on share
run ghost.toggle.js on silent
run ghost.toggle.js on xp
run ghost.toggle.js off xp
```

Supported features:

- `share`: enables leftover RAM to run `ghost.share.js`.
- `silent`: suppresses periodic controller chatter.
- `xp`: switches auto-targeting from money-first to hacking-XP-first.

The XP mode is controlled by `ghost.xp.enabled.txt`. When present, the controller prefers targets near your current hacking level and prioritizes `weaken`/`grow` work ahead of money-taking `hack` work.

### Other ghost scripts

- `ghost.hack.js`: worker that runs `ns.hack(target)`.
- `ghost.grow.js`: worker that runs `ns.grow(target)`.
- `ghost.weaken.js`: worker that runs `ns.weaken(target)`.
- `ghost.share.js`: worker that runs `ns.share()`.
- `ghost.report.js`: shows available fleet RAM and active ghost assignments.
- `ghost.chart.js`: maps network targets, showing hackability, prep state, money, security, and optional connection paths.
- `ghost.route.js`: prints the connection path from `home` to a target server, with an optional `connect` command chain.
- `ghost.trophies.js`: attempts low-effort achievements by creating helper scripts, buying the first hacknet node, and using Singularity actions when available.

Run it with:

```text
run ghost.chart.js
run ghost.chart.js --all
run ghost.chart.js --paths --sort depth
run ghost.route.js --target run4theh111z
run ghost.route.js --target CSEC --cmd
run ghost.trophies.js
run ghost.trophies.js --dry-run
```

Supported flags:

- `--all`: include non-hackable and utility hosts instead of only money-bearing targets.
- `--paths`: include the full connection path from `home` to each host.
- `--sort <score|depth|req|money|ram|name>`: sort the listing.
- `ghost.route.js --target <host>`: resolve a single target path.
- `ghost.route.js --cmd`: also print a `connect ...;` command chain for terminal use.
- `ghost.trophies.js --dry-run`: show what achievement actions would be attempted without spending money or writing files.
- `ghost.trophies.js --folder <dir>`: choose where achievement helper scripts are written.
- `ghost.trophies.js --force-files`: rewrite the helper files even if they already exist.

## Purchased server automation

`fleet.js` buys and upgrades purchased servers. It fills empty slots first, then marks the weakest server for decommission, waits for ghost workers to drain off it, deletes it, and repurchases it at a higher RAM tier.

Run it with:

```text
run fleet.js
run fleet.js --once
run fleet.js --reserve-cash 5m --spend-ratio 0.5
```

Supported flags:

- `--interval <ms>`: polling interval between fleet management passes.
- `--once`: run one pass and exit.
- `--prefix <name>`: purchased server hostname prefix.
- `--reserve-cash <amount>`: money to keep untouched on `home`. Supports suffixes like `k`, `m`, `b`, and `t`.
- `--pause-spare-ratio <0-1>`: pause buying or upgrades while too much purchased-server RAM is still free.
- `--pause-spare-gb <gb>`: absolute free-RAM pause threshold.
- `--spend-ratio <0-1>`: fraction of available post-reserve cash to spend.
- `--verbose <true|false>`: control status output.

`fleet.js` shares the `ghost.decommission.txt` and `ghost.silent.enabled.txt` control files with the ghost controller, so upgrades coordinate with active ghost workloads and honor silent mode.

`fleet.status.js` reports purchased-server status, including fleet-wide RAM totals, free capacity, decommission state, next affordable purchase or upgrade, and a per-host activity listing.

Run it with:

```text
run fleet.status.js
run fleet.status.js --reserve-cash 5m
run fleet.status.js --sort free
```

Supported flags:

- `--reserve-cash <amount>`: money to exclude from upgrade and purchase readiness calculations. Supports suffixes like `k`, `m`, `b`, and `t`.
- `--sort <ram|free|used|threads|name>`: sort the per-host listing.
