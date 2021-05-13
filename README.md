
# Stock Share Monitoring

Small app written in Python to monitor the stock shares you own. It uses InfluxDB as TSDB and Yfinance to scrape the price in realtime.  

# Installation

You can use docker-compose to install a full stack with InfluxDB and Grafana included or the app in standalone mode.

## Full-stack mode (docker-compose)

### **Requirements**
* docker
* docker-compose 

1. Clone the project
    ```bash
    git clone https://github.com/pbrissaud/suivi-bourse-app.git
    ```

2. Move to the directory
    ```bash
    cd suivi-bourse-app
    ```

3. Copy data/data-example.json to data/data.json
    ```bash
    cp data/data-example.json data/data.json
    ```

4. Modify the data/data.json file following the model
    ```bash
    vim data/data.json
    ```

5. Start the stack
    ```bash
    docker-compose up
    ```

6. Connect to Grafana (`http://localhost:3000`) with credentials `admin/admin` (you can change the password right after your first login)

7. Go to dashboard `Stock share monitoring` and see !  
*NB: for the graph cell you need to wait ~10 min to see something*

## Standalone mode

### **Requirements**
* Python v3.x  (tested with 3.8 and 3.9)
* Pip
* An influxDB database in **1.x** (tested with 1.7 and 1.8) 

1. Clone the project
    ```bash
    git clone https://github.com/pbrissaud/suivi-bourse-app.git
    ```

2. Move to the directory
    ```bash
    cd suivi-bourse-app
    ```

3. Install python dependencies
    ```bash
    python3 -m pip install -r requirements.txt
    ```

4. Copy data/data-example.json to anywhere you want and modify it accordings to your needs

5. Create a InfluxDB database (default name is `bourse`)
    ```bash
    influx> CREATE DATABSE bourse
    ```
    
6. Run the app 
    ```bash
    python3 app/main.py --config <path_to_data_file> 
    ```

7. You can import the Grafana dashboard (file is located in `grafana-provisionning/dashbaords/suivi-bourse.json`). Care you must have Grafana > 7.4 (using new Time Serie Cell) 

### **CLI Options**

```
OPTION                  DESCRIPTION
-h, --help              Show manual
-H, --host              InfluxDB Host
-p, --port              InfluxDB Port
-D, --database          InfluxDB Database
-U, --username          InfluxDB Username
-P, --password          InfluxDB Password
-i, --interval          Application Scraping Interval (seconds)
-c, --config            Data file path
```

# Data.json file model

* YAML Schema used for validation :  [app/schema.yaml](app/schema/yaml)

* Example : [data/data-example.json](data/data-example.json)