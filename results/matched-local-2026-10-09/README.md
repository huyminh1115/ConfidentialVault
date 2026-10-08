# Recorded matched local campaign

The JSON contains the final 30-trial observations and the exact clean source commit used to generate them. Compiler, Hardhat/EDR, host and local network settings match the companion repository. The FHE execution remains a local mock. See `../../PAPER_REPRODUCTION.md` for the normalized fixtures, exclusions and rerun command.

Within-run SD is zero under restored snapshots and reused inputs; fresh encrypted/proof bytes can change intrinsic gas between runs. These files replace the earlier gas table, not the historical proof-timing or leakage results.
