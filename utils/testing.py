import requests
import sys
import re

metrics = ['sb_share_price', 'sb_purchased_quantity',
           'sb_purchased_price', 'sb_purchased_fee', 'sb_owned_quantity', 'sb_received_dividend', 'sb_share_info']

r = requests.get('http://localhost:8081/metrics')

if r.status_code != 200:
    print('Not received 200 response code')
    sys.exit(1)

for metric in metrics:
    if not isinstance(re.search(metric, r.text), re.Match):
        print('Metric %s not found' % metric)
        sys.exit(1)

print('Don\'t worry about a thing')
print('Cause every little thing gonna be all right.')
sys.exit(0)
