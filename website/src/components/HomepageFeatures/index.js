import React from 'react';
import clsx from 'clsx';
import Translate from '@docusaurus/Translate';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: <Translate id="home.feature.ledger.title">Your trades in</Translate>,
    description: (
      <Translate id="home.feature.ledger.body">
        Record your purchases, sales, dividends and deposits in the app, or import
        them from a CSV or Excel file.
      </Translate>
    ),
  },
  {
    title: <Translate id="home.feature.figures.title">Your figures out</Translate>,
    description: (
      <Translate id="home.feature.figures.body">
        Prices are fetched and the history is rebuilt for you. You get your
        gains, returns and projected tax, in one currency.
      </Translate>
    ),
  },
  {
    title: <Translate id="home.feature.container.title">One container</Translate>,
    description: (
      <Translate id="home.feature.container.body">
        One Docker image with its own store and interface. Nothing else to
        install, and your data stays on your machine.
      </Translate>
    ),
  },
];

function Feature({title, description}) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
