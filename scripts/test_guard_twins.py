"""The ml and scripts conftests carry one no-database guard, twice.

The two suites run from different roots and ml/ must work without scripts/,
so the guard cannot be shared through an import. A comment saying "keep them
the same" is all that held them together; this test compares the text instead.

The guard section runs from the "No-database guard" rule line to the "End
no-database guard" rule line in each conftest. Run:

    ml/.venv/Scripts/pytest scripts/test_guard_twins.py -q
"""

from __future__ import annotations

import difflib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
START = '# ── No-database guard'
END = '# ── End no-database guard'


def guard_section(text: str) -> list[str]:
    """The lines from the start rule to the end rule, both included."""
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if line.startswith(START)]
    ends = [i for i, line in enumerate(lines) if line.startswith(END)]
    if len(starts) != 1 or len(ends) != 1 or starts[0] >= ends[0]:
        raise ValueError(
            f'expected one {START!r} line before one {END!r} line, '
            f'found {len(starts)} and {len(ends)}'
        )
    return lines[starts[0] : ends[0] + 1]


def test_the_two_conftests_carry_the_same_guard():
    ml = guard_section((REPO / 'ml' / 'conftest.py').read_text(encoding='utf-8'))
    scripts = guard_section(
        (REPO / 'scripts' / 'conftest.py').read_text(encoding='utf-8')
    )
    drift = '\n'.join(
        difflib.unified_diff(ml, scripts, 'ml/conftest.py', 'scripts/conftest.py', lineterm='')
    )
    assert ml == scripts, f'the guard sections differ:\n{drift}'
    # A guard that shrank to nothing would still "match".
    assert len(ml) > 50


@pytest.mark.parametrize(
    'text',
    [
        '',
        f'{START}\nbody\n',
        f'{END}\n',
        f'{END}\n{START}\n',
        f'{START}\n{START}\n{END}\n',
    ],
    ids=['empty', 'no-end', 'no-start', 'end-first', 'two-starts'],
)
def test_a_file_without_one_well_ordered_section_is_rejected(text):
    with pytest.raises(ValueError, match='expected one'):
        guard_section(text)
