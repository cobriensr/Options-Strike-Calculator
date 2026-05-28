"""Identifier-validation guard on the bulk-insert helpers.

`_build_multi_row_insert` interpolates the table name and column names
directly into the INSERT template (parameterized SQL doesn't accept
identifiers as bind values). Today every caller passes module-level
constants — these tests pin the gate so a future handler can't
accidentally wire a user-derived value through and convert the bulk
helper into a SQL injection sink.
"""

from __future__ import annotations

import pytest

from db import _build_multi_row_insert, _validate_identifier


class TestValidateIdentifier:
    @pytest.mark.parametrize(
        "name",
        ["t", "_t", "Table1", "snake_case", "Camel_Case_99"],
    )
    def test_accepts_safe_identifiers(self, name: str) -> None:
        # No exception → pass.
        _validate_identifier(name, kind="table")

    @pytest.mark.parametrize(
        "name",
        [
            "1table",          # starts with digit
            "tab le",          # whitespace
            "tab;le",          # statement terminator
            "tab--le",         # SQL comment marker
            "tab/*le*/",       # block comment
            "tab\"le",         # quote
            "tab'le",          # single quote
            "tab`le",          # backtick
            "users; DROP TABLE", # textbook injection
            "",                # empty
            "café",            # non-ASCII letter
        ],
    )
    def test_rejects_unsafe_identifiers(self, name: str) -> None:
        with pytest.raises(ValueError, match="Invalid SQL identifier"):
            _validate_identifier(name, kind="table")

    def test_rejects_non_string(self) -> None:
        with pytest.raises(ValueError, match="Invalid SQL identifier"):
            _validate_identifier(123, kind="table")  # type: ignore[arg-type]


class TestBuildMultiRowInsertGuards:
    def test_rejects_unsafe_table_name(self) -> None:
        with pytest.raises(ValueError, match="table"):
            _build_multi_row_insert(
                "users; DROP TABLE x",
                ["a"],
                [(1,)],
            )

    def test_rejects_unsafe_column_name(self) -> None:
        with pytest.raises(ValueError, match="column"):
            _build_multi_row_insert(
                "t",
                ["a", "b; DROP TABLE x"],
                [(1, 2)],
            )

    def test_accepts_well_formed_call(self) -> None:
        sql, params = _build_multi_row_insert(
            "ws_flow_alerts",
            ["alert_id", "ticker"],
            [("abc", "SPY"), ("def", "QQQ")],
        )
        assert "INSERT INTO ws_flow_alerts" in sql
        assert params == ["abc", "SPY", "def", "QQQ"]
