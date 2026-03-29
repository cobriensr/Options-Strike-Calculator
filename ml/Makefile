# ML Pipeline Runner
# Usage: cd ml && make all

PYTHON := .venv/bin/python

.PHONY: all eda cluster visualize health milestone backtest early clean help

all: eda cluster visualize ## Run full analysis pipeline

eda: ## Run exploratory data analysis
	$(PYTHON) eda.py

cluster: ## Run clustering analysis with plots
	$(PYTHON) clustering.py --plot

visualize: ## Generate all visualization plots
	$(PYTHON) visualize.py

health: ## Check pipeline health (data freshness, completeness)
	$(PYTHON) health.py

milestone: ## Check data milestones and suggest next actions
	$(PYTHON) milestone_check.py

backtest: ## Run simplified P&L backtest
	$(PYTHON) backtest.py

early: ## Run Phase 2 early feasibility experiment
	$(PYTHON) phase2_early.py

early-shap: ## Run Phase 2 early experiment with SHAP plots
	$(PYTHON) phase2_early.py --shap

full: health all backtest milestone ## Run everything: health + analysis + backtest + milestones

clean: ## Remove generated plots
	rm -f plots/*.png

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'
