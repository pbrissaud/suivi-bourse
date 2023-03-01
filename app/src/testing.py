from prometheus_client.parser import text_string_to_metric_families
import requests
import sys
import prometheus_client
import yaml
import os
from cerberus import Validator
from confuse import Configuration
from pathlib import Path

from main import SuiviBourseMetrics

# Load config
config = Configuration('SuiviBourse', __name__)

# Load schema file
with open(Path(__file__).parent / "schema.yaml", encoding='UTF-8') as f:
    dataSchema = yaml.safe_load(f)
shares_validator = Validator(dataSchema)

try:
    # Start up the server to expose the metrics.
    prometheus_client.start_http_server(
        int(os.getenv('SB_METRICS_PORT', default='8081')))
    # Init SuiviBourseMetrics
    sb_metrics = SuiviBourseMetrics(config, shares_validator)
    # Schedule run the job on startup.
    sb_metrics.run()
except Exception:
    print('Program failed to start')
    sys.exit(1)

r = requests.get('http://localhost:8081/metrics')

if r.status_code != 200:
    print('Not received 200 response code')
    sys.exit(1)

metrics = r.text

print('metrics:')
for family in text_string_to_metric_families(metrics):
    for sample in family.samples:
        if sample.name.startswith('sb_') and sample.name != 'sb_share_info':
            print(sample.name + ' => ' + str(sample.value))
            if sample.value is None:
                sys.exit(1)
        if sample.name == 'sb_share_info':
            print('\nlabels:')
            for k, v in sample.labels.items():
                print(k + ' => ' + v)
                if v is None or v == 'undefined':
                    print('Undefined label value : ' + k)
                    sys.exit(1)

print('\nAll checks passed !')
