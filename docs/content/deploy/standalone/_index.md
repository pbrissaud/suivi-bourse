+++
title = "Standalone"
weight = 10
+++

Standalone mode only deploys the **Python script**. You should install and configure Prometheus and Grafana (or another tools if you want) by yourself to have the stack described in the [Design](/basics/design) section. 

{{% notice info %}}
You can use **virtualenv** to install and run the app in an isolated environment
{{% /notice %}}

## Requirements
* Windows, Linux or macOS 
* Python3 (version 3.8, 3.9 and 3.10 are tested)

## Steps

1. Download the source code of the project from the [latest release](https://github.com/pbrissaud/suivi-bourse/releases/latest) and extract it.

2. Move to the downloaded folder and execute this command in **app** folder: 
```Bash
python3 -m pip install -r requirements.txt
```

3. Write a `config.yaml` (name can't be changed) following the [chapter 3](/config) in **one of the following paths** : 
    {{< tabs >}}
    {{% tab name="Linux" %}}
* ~/.config/app/SuiviBourse
* /etc/app/SuiviBourse
    {{% /tab %}}
    {{% tab name="Windows" %}}
* %APPDATA%\app\SuiviBourse (APPDATA environment variable falls back to %HOME%\AppData\Roaming if undefined)
    {{% /tab %}}
    {{% tab name="Mac" %}}
* ~/.config/app/SuiviBourse
* ~/Library/Application Support/app/SuiviBourse
    {{% /tab %}}
    {{< /tabs >}}

{{% notice note %}}
To know more about config file location, please refer to the [confuse library documentation](https://confuse.readthedocs.io/en/latest/usage.html#search-paths)
{{% /notice %}}

4. Run the app :
```Bash
python3 src/main.py
```

## Environment variables

Env variables can be used to override some default parameters : 

| ENV                  | Description                                                     | Default Value |
|----------------------|-----------------------------------------------------------------|---------------|
| SB_METRICS_PORT      | Port TCP used to expose data                                    | 8081          |
| SB_SCRAPING_INTERVAL | Interval in seconds where app gets data from Yahoo! Finance API | 120           |


## Prometheus configuration

Add a static config to your Prometheus instance, to scrape data expoed by the app. Below, an example of configuration :

```yaml
scrape_configs:
  - job_name: 'suivi-bourse'
    scrape_interval: '120s'
    static_configs:
      - targets: ['localhost:8081']
```

## Grafana dashboard

You add manually add [this dashboard](https://github.com/pbrissaud/suivi-bourse/blob/master/assets/grafana-dashboard-external.json) to your Grafana instance.