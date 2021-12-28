+++
title = "Design"
weight = 10
+++

1. The app reads the configuration file describing all the stock share you own 
2. Every 120 seconds (this is the default value, it can be changed with env variable), the app calls Yahoo! Finance API to get the current value of all your owned shares
3. The app exposes the data in OpenMetrics format
4. Prometheus scrapes this data and stores it
5. Grafana reads Prometheus to display the data in a dashboard

{{< mermaid >}}
graph RL
    A[Yahoo! Finance API] -->|Get financial data| B(SuiviBourse)
    B --> E(Configuration file)
    C[Prometheus] -->|Scrapes exposed data| B
    D[Grafana] --> C
{{< /mermaid >}}