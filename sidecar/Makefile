# Sidecar Quality Gate
# Usage: cd sidecar && make review

PYTHON ?= .venv/bin/python

.PHONY: lint format test test-cov test-html review clean help

lint: ## Check code quality (ruff lint + format check)
	$(PYTHON) -m ruff check src/ tests/
	$(PYTHON) -m ruff format --check src/ tests/

format: ## Auto-fix lint and formatting issues
	$(PYTHON) -m ruff check --fix src/ tests/
	$(PYTHON) -m ruff format src/ tests/

review: lint test-cov ## Full quality gate: lint + tests + coverage

test: ## Run unit tests
	$(PYTHON) -m pytest tests/ -v

test-cov: ## Run tests with coverage report
	$(PYTHON) -m pytest tests/ --cov=src --cov-report=term-missing -v

test-html: ## Run tests with HTML coverage report
	$(PYTHON) -m pytest tests/ --cov=src --cov-report=html --cov-report=term-missing -v
	@echo "Open sidecar/htmlcov/index.html to view report"

clean: ## Remove generated artifacts
	rm -rf htmlcov/ .pytest_cache/ .ruff_cache/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'
