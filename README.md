# bitburner-scripts
My own Bitburner scripts

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
