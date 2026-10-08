.DEFAULT_GOAL := help
NPM ?= npm

.PHONY: help setup check benchmark reproduce
help:
	@printf '%s\n' 'make reproduce-matched  Run the current matched local paper campaign'
	@printf '%s\n' 'make setup      Install lockfile dependencies (Node 22.16.0 recommended)' 'make check      Check benchmark prerequisites without running trials' 'make benchmark  Run the paper measurement procedure in a fresh output directory' 'make reproduce  Install dependencies, then run the benchmark'

setup:
	$(NPM) ci

check:
	@sh scripts/reproduce-paper.sh --check

benchmark:
	@sh scripts/reproduce-paper.sh

reproduce: setup
	$(MAKE) benchmark

.PHONY: benchmark-matched reproduce-matched
benchmark-matched:
	@sh scripts/reproduce-matched.sh

reproduce-matched: setup
	$(MAKE) benchmark-matched
