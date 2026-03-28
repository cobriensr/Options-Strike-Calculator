# ML Pipeline Runner
# Usage: cd ml && make all

PYTHON := .venv/bin/python

.PHONY: all eda cluster visualize clean help

all: eda cluster visualize ## Run full analysis pipeline

eda: ## Run exploratory data analysis
	$(PYTHON) eda.py

cluster: ## Run clustering analysis with plots
	$(PYTHON) clustering.py --plot

visualize: ## Generate all visualization plots
	$(PYTHON) visualize.py

clean: ## Remove generated plots
	rm -f plots/*.png

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'
