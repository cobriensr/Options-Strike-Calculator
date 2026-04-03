# ML Pipeline Runner
# Usage: cd ml && make all

PYTHON := .venv/bin/python

.PHONY: all eda cluster visualize health milestone backtest early pin test test-cov test-html clean help

all: eda cluster visualize ## Run full analysis pipeline

eda: ## Run exploratory data analysis
	$(PYTHON) src/eda.py

cluster: ## Run clustering analysis with plots
	$(PYTHON) src/clustering.py --plot

visualize: ## Generate all visualization plots
	$(PYTHON) src/visualize.py

health: ## Check pipeline health (data freshness, completeness)
	$(PYTHON) src/health.py

milestone: ## Check data milestones and suggest next actions
	$(PYTHON) src/milestone_check.py

backtest: ## Run simplified P&L backtest
	$(PYTHON) src/backtest.py

early: ## Run Phase 2 early feasibility experiment
	$(PYTHON) src/phase2_early.py

early-shap: ## Run Phase 2 early experiment with SHAP plots
	$(PYTHON) src/phase2_early.py --shap

pin: ## Run settlement pin risk / gamma correlation analysis
	$(PYTHON) src/pin_analysis.py

test: ## Run unit tests
	$(PYTHON) -m pytest -v

test-cov: ## Run tests with coverage report
	$(PYTHON) -m pytest --cov --cov-report=term-missing -v

test-html: ## Run tests with HTML coverage report
	$(PYTHON) -m pytest --cov --cov-report=html --cov-report=term-missing -v
	@echo "Open ml/htmlcov/index.html to view report"

full: health all backtest milestone ## Run everything: health + analysis + backtest + milestones

clean: ## Remove generated plots
	rm -f plots/*.png

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'
