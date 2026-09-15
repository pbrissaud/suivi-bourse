"""What one account would owe if it were emptied today (#919).

Pure arithmetic, so every test here is scalar and none of them opens a store.
What is under test is not that a function was called: it is the four rules the
projection *is* — the assiette a kind reads, the levy that adds on both sides of
a threshold, the floor at zero, and the difference between a gain of zero and a
gain nobody knows.
"""
from datetime import date

import pytest

from application import taxation
from application import taxation_projection as projection


PEA = {'rate_before': 0.128, 'rate_after': 0.0, 'threshold_years': 5,
       'age_basis': taxation.FIRST_PAYMENT, 'social_rate': 0.172}

ASSURANCE_VIE = {'rate_before': 0.128, 'rate_after': 0.075,
                 'threshold_years': 8, 'age_basis': taxation.OPENING,
                 'social_rate': 0.172}

CTO = {'rate': 0.128, 'social_rate': 0.172}


def aged(parameters, gain, *, now, opened_on=None, first_payment=None):
    return projection.projected_tax(
        kind=taxation.AGED_FLAT_REALISED, parameters=parameters,
        latent_gain=gain, opened_on=opened_on,
        first_payment=first_payment, now=now)


def flat(parameters, gain):
    return projection.projected_tax(
        kind=taxation.FLAT_REALISED, parameters=parameters,
        latent_gain=gain, now=date(2026, 9, 15))


def rates(parameters, kind, **facts):
    return projection.applied_rates(kind=kind, parameters=parameters,
                                    now=date(2026, 9, 15), **facts)


def bracketed(brackets, gain):
    return projection.projected_tax(
        kind=taxation.BRACKETED_REALISED, parameters={'brackets': brackets},
        latent_gain=gain, now=date(2026, 9, 15))


# --------------------------------------------------------------------------- #
# One assiette, three kinds
# --------------------------------------------------------------------------- #

def test_the_three_kinds_read_one_assiette_and_differ_only_in_the_rate():
    """`gain_absolu` was the aged family's assiette until the review of
    2026-09-15 found what it is: `total_value − net_contributed`, whose
    contribution is net of **withdrawals**. A gain realised and taken out years
    ago stayed in it for ever, so an emptied wrapper was billed tax on money it
    no longer held while the same account under a flat model answered zero.

    One question — *what would you owe if you sold everything today* — so one
    assiette. The kind decides the rate and nothing else.
    """
    emptied = 0.0
    assert flat(CTO, emptied) == 0.0
    assert aged(PEA, emptied, first_payment=date(2015, 3, 1),
                now=date(2026, 9, 15)) == 0.0
    assert bracketed(list(LADDER), emptied) == 0.0


# --------------------------------------------------------------------------- #
# The levy adds on BOTH sides of the threshold
# --------------------------------------------------------------------------- #

def test_a_mature_pea_owes_no_income_tax_and_still_owes_its_social_levy():
    """The bug this whole module is shaped to make unavailable.

    A PEA past five years is exempt of *income* tax — ``rate_after`` is 0,0 —
    and its gain is still subject to the 17,2 % social levy. A projection that
    reads ``rate_after`` alone tells an owner they owe nothing on a gain that
    will cost them a sixth of itself.
    """
    tax = aged(PEA, 10_000.0, opened_on=date(2015, 3, 1), now=date(2026, 9, 15))
    assert tax == pytest.approx(1_720.0)


def test_an_assurance_vie_past_its_eighth_year_pays_the_reduced_rate_plus_the_levy():
    """The carve-out: 7,5 % of income tax, and the same 17,2 % beside it."""
    tax = aged(ASSURANCE_VIE, 10_000.0, opened_on=date(2010, 1, 1),
               now=date(2026, 9, 15))
    assert tax == pytest.approx(2_470.0)


def test_before_the_threshold_the_levy_is_the_same_levy():
    tax = aged(ASSURANCE_VIE, 10_000.0, opened_on=date(2025, 1, 1),
               now=date(2026, 9, 15))
    assert tax == pytest.approx(3_000.0)


# --------------------------------------------------------------------------- #
# The day the threshold is counted from — the amendment to D2
# --------------------------------------------------------------------------- #

def test_a_pea_declared_through_the_shipped_template_still_projects():
    """The reversal, stated as a test.

    ``fr_pea`` ships ``age_basis: FIRST_PAYMENT``, and the form renders the
    ``opened_on`` field only under ``opening`` — so a PEA declared through the
    shortcut this app ships carries **no** declared opening date, for ever. Read
    that date alone and the card never appears on the feature's flagship case.
    """
    tax = aged(PEA, 10_000.0, opened_on=None,
               first_payment=date(2015, 3, 1), now=date(2026, 9, 15))
    assert tax == pytest.approx(1_720.0)


def test_a_declared_date_still_wins_over_the_derived_one():
    """#918 is not reintroduced: the fallback fills an absence, it never
    overwrites a declaration."""
    assert projection.age_date(PEA, date(2020, 6, 1), date(2015, 3, 1)) \
        == date(2020, 6, 1)


def test_under_opening_the_ledger_is_not_consulted_at_all():
    """An ``opening`` wrapper runs from what was declared about it. A first
    payment is not an opening, and borrowing one here would age an account on a
    fact it never claimed."""
    assert projection.age_date(ASSURANCE_VIE, None, date(2010, 1, 1)) is None
    assert aged(ASSURANCE_VIE, 10_000.0, first_payment=date(2010, 1, 1),
                now=date(2026, 9, 15)) is None


# --------------------------------------------------------------------------- #
# Completed anniversaries
# --------------------------------------------------------------------------- #

def test_the_threshold_is_reached_on_the_anniversary_itself():
    """Five years to the day is five years, and the day before is not."""
    assert aged(PEA, 10_000.0, opened_on=date(2021, 9, 15),
                now=date(2026, 9, 15)) == pytest.approx(1_720.0)
    assert aged(PEA, 10_000.0, opened_on=date(2021, 9, 15),
                now=date(2026, 9, 14)) == pytest.approx(3_000.0)


def test_a_29_february_wrapper_ages_on_the_28th_in_a_common_year():
    """Four years out of five have no 29th, and the wrapper does not wait for
    one: 2020-02-29 turns five on 2025-02-28."""
    five = dict(ASSURANCE_VIE, threshold_years=5)
    assert projection.threshold_day(five, date(2020, 2, 29)) == date(2025, 2, 28)
    assert aged(five, 10_000.0, opened_on=date(2020, 2, 29),
                now=date(2025, 2, 28)) == pytest.approx(2_470.0)
    assert aged(five, 10_000.0, opened_on=date(2020, 2, 29),
                now=date(2025, 2, 27)) == pytest.approx(3_000.0)


def test_a_threshold_that_runs_off_the_calendar_projects_nothing(tmp_path=None):
    """`MAX_THRESHOLD_YEARS` bounds the span and nothing bounds the start.

    A wrapper declared as opened in 9999 plus a two-century threshold is a date
    Python has no year for, and the read is where the guard belongs: the write
    is checked once, this is asked on every page that lists the accounts, and a
    row written before the bound existed would otherwise take that page down.
    """
    far = dict(ASSURANCE_VIE, threshold_years=200)
    assert projection.threshold_day(far, date(9999, 12, 31)) is None
    assert aged(far, 10_000.0, opened_on=date(9999, 12, 31),
                now=date(2026, 9, 15)) is None
    assert rates(far, taxation.AGED_FLAT_REALISED,
                 opened_on=date(9999, 12, 31)) is None


def test_a_threshold_off_the_calendar_names_no_day_it_changes_on_either():
    """``rate_changes_on`` is the third reader of ``threshold_day`` and the one
    that would *raise* rather than answer: it compares the day against ``now``,
    and ``None <= date`` is a ``TypeError`` raised on the very page its owner
    would repair the row from. The guard is the same absence the other two
    publish, and it is asserted here rather than assumed from them."""
    assert projection.rate_changes_on(
        kind=taxation.AGED_FLAT_REALISED,
        parameters=dict(ASSURANCE_VIE, threshold_years=200),
        opened_on=date(9999, 12, 31), now=date(2026, 9, 15)) is None


# --------------------------------------------------------------------------- #
# The floor, and the difference between zero and unknown
# --------------------------------------------------------------------------- #

def test_a_model_declaring_no_levy_adds_nothing_rather_than_inventing_one():
    """``social_rate`` is optional on both kinds that carry one, and absent means
    nothing. Every other case here multiplies the levy by a gain of zero, so
    this is the one that would notice a default creeping in."""
    assert flat({'rate': 0.30}, 10_000.0) == pytest.approx(3_000.0)
    assert aged({'rate_before': 0.30, 'rate_after': 0.0, 'threshold_years': 5,
                 'age_basis': taxation.OPENING}, 10_000.0,
                opened_on=date(2024, 1, 1), now=date(2026, 9, 15)) \
        == pytest.approx(3_000.0)


def test_an_account_in_loss_owes_nothing_rather_than_a_negative():
    assert flat(CTO, -8_000.0) == 0.0
    assert aged(PEA, -8_000.0, opened_on=date(2024, 1, 1),
                now=date(2026, 9, 15)) == 0.0
    assert bracketed([{'upper_bound': None, 'rate': 0.42}], -8_000.0) == 0.0


def test_a_gain_nobody_knows_is_not_a_gain_of_zero():
    """One unvalued line makes the assiette unknown, and the figure does not
    exist. Zero would be a claim; ``None`` is the absence the route publishes as
    a missing member."""
    assert flat(CTO, None) is None
    assert bracketed([{'upper_bound': None, 'rate': 0.42}], None) is None
    assert aged(PEA, None, opened_on=date(2015, 1, 1),
                now=date(2026, 9, 15)) is None


def test_an_aged_wrapper_with_no_date_anywhere_projects_nothing():
    assert aged(PEA, 10_000.0, now=date(2026, 9, 15)) is None


# --------------------------------------------------------------------------- #
# Which kinds project
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize('kind', [taxation.NONE, taxation.WITHHOLDING_INCOME])
def test_the_two_kinds_with_no_realised_gain_project_nothing(kind):
    """``none`` is worth ``0 €`` on the screen and that zero is *the model
    saying so*, not arithmetic. Publishing it as a computed figure would make a
    declared exemption indistinguishable from a measured zero."""
    assert projection.projected_tax(
        kind=kind, parameters={'rate': 0.30}, latent_gain=10_000.0,
        now=date(2026, 9, 15)) is None


def test_every_kind_the_record_holds_is_answered_one_way_or_the_other():
    """A kind added to :mod:`application.taxation` and forgotten here would
    fall through to ``None`` in silence. **The partition is what notices** — a
    subset would stay true however many kinds were added, which is exactly the
    regression it claims to catch."""
    assert set(taxation.KINDS) == set(projection.PROJECTED_KINDS) | {
        taxation.NONE, taxation.WITHHOLDING_INCOME}


# --------------------------------------------------------------------------- #
# The ladder, slice by slice
# --------------------------------------------------------------------------- #

LADDER = ({'upper_bound': 10_000.0, 'rate': 0.10},
          {'upper_bound': 50_000.0, 'rate': 0.30},
          {'upper_bound': None, 'rate': 0.42})


def test_a_bracketed_gain_is_taxed_slice_by_slice_and_not_at_its_top_rate():
    """60 000 € is 1 000 + 12 000 + 4 200, not 25 200."""
    assert bracketed(list(LADDER), 60_000.0) == pytest.approx(17_200.0)


def test_a_gain_inside_the_first_rung_never_reaches_the_second():
    assert bracketed(list(LADDER), 4_000.0) == pytest.approx(400.0)


def test_a_gain_landing_exactly_on_a_bound_stays_in_the_rung_below_it():
    assert bracketed(list(LADDER), 10_000.0) == pytest.approx(1_000.0)


def test_the_top_rung_is_open_and_takes_everything_above_the_one_below_it():
    assert bracketed(list(LADDER), 1_050_000.0) == pytest.approx(
        1_000.0 + 12_000.0 + 0.42 * 1_000_000.0)


def test_a_ladder_the_record_would_accept_is_a_ladder_this_walk_accepts():
    """The walk trusts :func:`taxation.validate` for the ladder's shape, so the
    two are checked against each other rather than against a hand-written dict."""
    checked = taxation.validate(taxation.BRACKETED_REALISED,
                                {'brackets': list(LADDER)})
    assert bracketed(checked['brackets'], 60_000.0) == pytest.approx(17_200.0)


# --------------------------------------------------------------------------- #
# What the footing names — published, never re-derived in the browser
# --------------------------------------------------------------------------- #

def test_a_flat_model_names_one_rate_with_its_levy_folded_in():
    assert rates(CTO, taxation.FLAT_REALISED) == pytest.approx([0.30])


def test_a_mature_wrapper_names_the_levy_and_not_the_exemption():
    """`rate_after` alone reads `0 %` beside a figure that is not zero. The
    footing names what produced the figure, so it names the levy."""
    assert rates(PEA, taxation.AGED_FLAT_REALISED,
                 first_payment=date(2015, 3, 1)) == pytest.approx([0.172])


def test_before_the_threshold_the_footing_names_the_rate_before():
    assert rates(PEA, taxation.AGED_FLAT_REALISED,
                 first_payment=date(2025, 3, 1)) == pytest.approx([0.30])


def test_a_ladder_names_its_rungs_there_being_no_single_rate():
    assert rates({'brackets': list(LADDER)},
                 taxation.BRACKETED_REALISED) == pytest.approx([0.1, 0.3, 0.42])


def test_a_wrapper_with_no_date_to_age_from_names_no_rate_at_all():
    assert rates(PEA, taxation.AGED_FLAT_REALISED) is None


@pytest.mark.parametrize('kind', [taxation.NONE, taxation.WITHHOLDING_INCOME])
def test_a_kind_with_no_realised_gain_names_no_rate(kind):
    assert rates({'rate': 0.30}, kind) is None


def test_the_day_the_rate_changes_is_the_anniversary_and_only_while_ahead():
    """Reached **on** the anniversary — the same rule the arithmetic reads, and
    it is read from the same function so the two cannot disagree."""
    ahead = projection.rate_changes_on(
        kind=taxation.AGED_FLAT_REALISED, parameters=PEA,
        first_payment=date(2025, 3, 1), now=date(2026, 9, 15))
    assert ahead == date(2030, 3, 1)

    # On the day itself the threshold is behind: there is nothing still to come.
    assert projection.rate_changes_on(
        kind=taxation.AGED_FLAT_REALISED, parameters=PEA,
        first_payment=date(2021, 9, 15), now=date(2026, 9, 15)) is None


def test_nothing_changes_for_a_model_that_does_not_age():
    assert projection.rate_changes_on(
        kind=taxation.FLAT_REALISED, parameters=CTO,
        now=date(2026, 9, 15)) is None


def test_a_29_february_wrapper_changes_rate_on_the_28th_of_a_common_year():
    """2020-02-29 turns five on 2025-02-28 — and eight on 2028-02-**29**, that
    year having one. Both are the same rule, and only the calendar differs."""
    five = dict(ASSURANCE_VIE, threshold_years=5)
    assert projection.rate_changes_on(
        kind=taxation.AGED_FLAT_REALISED, parameters=five,
        opened_on=date(2020, 2, 29), now=date(2021, 1, 1)) == date(2025, 2, 28)
    assert projection.rate_changes_on(
        kind=taxation.AGED_FLAT_REALISED, parameters=ASSURANCE_VIE,
        opened_on=date(2020, 2, 29), now=date(2021, 1, 1)) == date(2028, 2, 29)


def test_the_footing_and_the_figure_read_one_threshold_rule():
    """Spelled twice, the card could name a rate the figure beside it
    contradicts. `threshold_day` is the one statement of *reached*."""
    day = projection.threshold_day(PEA, date(2021, 9, 15))
    assert day == date(2026, 9, 15)
    assert rates(PEA, taxation.AGED_FLAT_REALISED,
                 first_payment=date(2021, 9, 15)) == pytest.approx([0.172])
    assert projection.rate_changes_on(
        kind=taxation.AGED_FLAT_REALISED, parameters=PEA,
        first_payment=date(2021, 9, 15), now=day) is None


# --------------------------------------------------------------------------- #
# The walk cannot return a negative, whatever it is handed
# --------------------------------------------------------------------------- #

def test_the_walk_floors_at_zero_even_on_a_ladder_the_record_would_refuse():
    """The belt. `taxation._brackets` refuses a first ceiling at or below zero,
    and the floor at zero is this module's own stated rule — it may not rest on
    a validator one import away."""
    assert bracketed([{'upper_bound': -100.0, 'rate': 1.0},
                      {'upper_bound': None, 'rate': 0.0}], 1_000.0) == 0.0
