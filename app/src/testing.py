from prometheus_client.parser import text_string_to_metric_families
import requests
import sys
import prometheus_client
import yaml
from cerberus import Validator
from pathlib import Path

from main import SuiviBourseMetrics, ConfigurationManager

# Load schema file
with open(Path(__file__).parent / "schema.yaml", encoding='UTF-8') as f:
    dataSchema = yaml.safe_load(f)
shares_validator = Validator(dataSchema)

# Initialize configuration manager
config_manager = ConfigurationManager()

try:
    # Start up the server to expose the metrics.
    prometheus_client.start_http_server(8081)
    # Init SuiviBourseMetrics
    sb_metrics = SuiviBourseMetrics(config_manager, shares_validator)
    # Schedule run the job on startup.
    sb_metrics.run()
except Exception as e:
    print(f'Program failed to start: {e}')
    sys.exit(1)

r = requests.get('http://localhost:8081/metrics')

if r.status_code != 200:
    print('Not received 200 response code')
    sys.exit(1)

metrics = r.text

# Metrics that may not be available for all asset types (e.g., crypto)
optional_metrics = {'sb_dividend_yield', 'sb_pe_ratio', 'sb_market_cap'}

print('metrics:')
for family in text_string_to_metric_families(metrics):
    for sample in family.samples:
        if sample.name.startswith('sb_') and sample.name != 'sb_share_info':
            print(sample.name + ' => ' + str(sample.value))
            if sample.value is None and sample.name not in optional_metrics:
                print('Required metric has no value: ' + sample.name)
                sys.exit(1)
        if sample.name == 'sb_share_info':
            print('\nlabels:')
            for k, v in sample.labels.items():
                print(k + ' => ' + v)
                if v is None or v == 'undefined':
                    print('Undefined label value : ' + k)
                    sys.exit(1)

print('\nAll checks passed !')
