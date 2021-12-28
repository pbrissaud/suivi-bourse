+++
title = "Docker"
weight = 20
+++

Docker mode only deploys the **SuiviBourse container**. You should install and configure Prometheus and Grafana (or another tools if you want) by yourself to have the stack described in the [Design](/basics/design) section. 

## Requirements
* Windows, Linux or macOS 
* Docker (> 19.03)

{{% notice note %}}
The supported architecture are **amd64 and arm64**. If you want more supported architecture, please open a iussue on Github.
{{% /notice %}}

## Steps

1. Write a `config.yaml` (name can't be changed) following the [chapter 3](/config) in **one of the following paths** : 
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

{{% notice info %}}
To know more about config file location, please refer to the [confuse library documentation](https://confuse.readthedocs.io/en/latest/usage.html#search-paths)
{{% /notice %}}

3. Run the container :
```Bash
docker run -p 8081:8081 -v $HOME/.config/SuiviBourse:/home/appuser/.config/SuiviBourse suivi-bourse-app
```

## Environment variables

Env variables can be used to override some default parameters : 

| ENV                  | Description                                                     | Default Value |
|----------------------|-----------------------------------------------------------------|---------------|
| SB_SCRAPING_INTERVAL | Interval in seconds where app gets data from Yahoo! Finance API | 120           |

Use the **-e** or **--env** flags to set environment variables in the container.


*Example :*

```Bash
docker run -p 8081:8081 -v $HOME/.config/SuiviBourse:/home/appuser/.config/SuiviBourse -e SB_SCRAPING_INTERVAL=20 suivi-bourse-app
```

