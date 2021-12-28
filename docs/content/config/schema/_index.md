+++
title = "Write a config file"
weight = 10
+++

## Use Case 

I own some shares, that I want to monitor : 
* 2 shares of Apple stock (bought one, got the second free)
* 3 shares of Tesla stocks (bought not in the same time)

Here's the corresponding config file: 

```yaml
shares:


- name: Apple
  symbol: AAPL # Yahoo! finance stock symbol
  purchase:
    quantity: 1
    fee: 2 # Fees when I bought the share 
    cost_price: 119.98  # Value of the share when I bought it 
  estate:
    quantity: 2 # Because, I got one free
    received_dividend: 2.85 # Sum of all received dividend


- name: Tesla
  symbol: TLSA
  purchase:
    quantity: 3
    fee: 5.8 # When buying multiple shares, sum of fees
    cost_price: 856.87  # When buying multiple shares with different price, weighted average
  estate:
    quantity: 3
    received_dividend: 4.57
```



## Cerberus schema validator 

```yaml
shares:
  type: list
  required: True
  empty: False
  schema:
    type: dict
    required: True
    schema:
      name:
        type: string
        required: True
      symbol:
        type: string
        required: True
      purchase:
        type: dict
        required: True
        schema:
          quantity:
            type: number
            required: True
            min: 0
          fee:
            type: number
            required: True
            min: 0
          cost_price:
            type: number
            required: True
            min: 0
      estate:
        type: dict
        required: True
        schema:
          quantity:
            type: number
            required: True
            min: 0
          received_dividend:
            type: number
            required: True
            min: 0
```