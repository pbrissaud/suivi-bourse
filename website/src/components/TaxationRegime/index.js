import React from 'react';
import Translate from '@docusaurus/Translate';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// Every `website/taxation/<cc>.json` is read here, by `require.context`, so a
// country is one JSON file and one MDX section — never an edit of this file.
// The same files are what the app's registry (#1290) is generated from, which
// is the point: a rate lives in one place.
const files = require.context('../../../taxation', false, /\.json$/);
const WRAPPERS = new Map(
  files.keys().flatMap((key) => files(key).wrappers.map((wrapper) => [wrapper.id, wrapper])),
);

const KIND = {
  none: <Translate id="taxationRegime.kind.none">Not taxed</Translate>,
  flat_realised: <Translate id="taxationRegime.kind.flat_realised">One rate on the gain</Translate>,
  aged_flat_realised: (
    <Translate id="taxationRegime.kind.aged_flat_realised">A rate that changes with the wrapper’s age</Translate>
  ),
  bracketed_realised: <Translate id="taxationRegime.kind.bracketed_realised">Brackets on the gain</Translate>,
  withholding_income: <Translate id="taxationRegime.kind.withholding_income">A withholding on income</Translate>,
};

const LABEL = {
  rate: <Translate id="taxationRegime.param.rate">Rate</Translate>,
  social_rate: <Translate id="taxationRegime.param.social_rate">Social charges or levies</Translate>,
  rate_before: <Translate id="taxationRegime.param.rate_before">Rate before the threshold</Translate>,
  rate_after: <Translate id="taxationRegime.param.rate_after">Rate after the threshold</Translate>,
  threshold_years: <Translate id="taxationRegime.param.threshold_years">Threshold, in years</Translate>,
  age_basis: <Translate id="taxationRegime.param.age_basis">Counted from</Translate>,
};

const AGE_BASIS = {
  opening: <Translate id="taxationRegime.ageBasis.opening">The day the wrapper was opened</Translate>,
  first_payment: <Translate id="taxationRegime.ageBasis.first_payment">The first payment into it</Translate>,
};

function rows(parameters, format) {
  return Object.entries(parameters).flatMap(([name, value]) => {
    if (name === 'brackets') {
      return value.map(({upper_bound: bound, rate}, index) => ({
        key: `bracket-${index}`,
        label:
          bound === null ? (
            // A ladder of one rung has nothing below it: the rate is for everything.
            index === 0 ? (
              LABEL.rate
            ) : (
              <Translate
                id="taxationRegime.bracket.above"
                values={{bound: format.number.format(value[index - 1].upper_bound)}}>
                {'Above {bound}'}
              </Translate>
            )
          ) : (
            <Translate id="taxationRegime.bracket.upTo" values={{bound: format.number.format(bound)}}>
              {'Up to {bound}'}
            </Translate>
          ),
        value: format.percent.format(rate),
      }));
    }
    const shown =
      name === 'age_basis'
        ? AGE_BASIS[value]
        : name === 'threshold_years'
          ? format.integer.format(value)
          : format.percent.format(value);
    return [{key: name, label: LABEL[name], value: shown}];
  });
}

export default function TaxationRegime({id}) {
  const wrapper = WRAPPERS.get(id);
  // A typo fails `pnpm build`; it never renders an empty block.
  if (!wrapper) {
    throw new Error(`<TaxationRegime id="${id}" />: no such id in website/taxation/*.json`);
  }
  const {
    i18n: {currentLocale},
  } = useDocusaurusContext();
  const format = {
    // Up to three decimals: 1.375 % is a real figure, and 12.8 % must not read 12.800 %.
    percent: new Intl.NumberFormat(currentLocale, {style: 'percent', maximumFractionDigits: 3}),
    number: new Intl.NumberFormat(currentLocale),
    integer: new Intl.NumberFormat(currentLocale, {maximumFractionDigits: 0}),
    date: new Intl.DateTimeFormat(currentLocale, {dateStyle: 'long', timeZone: 'UTC'}),
  };

  return (
    <>
      {wrapper.model === null ? (
        <p>
          <Translate id="taxationRegime.noShape">No shape in the app represents this regime.</Translate>
        </p>
      ) : (
        <>
          <p>
            <strong>{KIND[wrapper.model.kind]}</strong>
            {' — '}
            <Translate id="taxationRegime.taxYear" values={{year: wrapper.tax_year}}>
              {'tax year {year}'}
            </Translate>
          </p>
          {Object.keys(wrapper.model.parameters).length > 0 && (
            <table>
              <tbody>
                {rows(wrapper.model.parameters, format).map(({key, label, value}) => (
                  <tr key={key}>
                    <td>{label}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <ul>
        {wrapper.sources.map((source) => (
          <li key={source.url}>
            <Translate
              id="taxationRegime.asOf"
              values={{date: format.date.format(new Date(source.consulted))}}>
              {'As of {date}'}
            </Translate>
            {' — '}
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.title}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
