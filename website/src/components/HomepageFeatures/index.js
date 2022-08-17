import React from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: 'Simple to use',
    description: (
      <>
        Write a small config file to describe your stock portfolio and visualize your data ! 
      </>
    ),
  },
  {
    title: 'Lightweight and Secure',
    description: (
      <>
        Suivi Bourse was designed to be run on every machine and following security principes.
      </>
    ),
  },
  {
    title: 'Deploy everywhere',
    description: (
      <>
        Run it as system service, docker container or docker-compose on all OS
      </>
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
