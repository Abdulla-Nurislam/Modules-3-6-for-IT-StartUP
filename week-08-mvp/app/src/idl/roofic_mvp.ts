/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/roofic_mvp.json`.
 */
export type RooficMvp = {
  "address": "4qSqEcJ7KhcFsLnURE6dHuQ8KSRkkEX56oFYiRk8zKKf",
  "metadata": {
    "name": "rooficMvp",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Roofic MVP — fractional rental property shares (Week 8 build sprint)"
  },
  "instructions": [
    {
      "name": "buyShares",
      "docs": [
        "Покупка долей. Оплата в SOL напрямую владельцу объекта."
      ],
      "discriminator": [
        40,
        239,
        138,
        154,
        8,
        37,
        106,
        108
      ],
      "accounts": [
        {
          "name": "property",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "property.authority",
                "account": "property"
              },
              {
                "kind": "account",
                "path": "property.id",
                "account": "property"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "property"
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "investor",
          "writable": true,
          "signer": true
        },
        {
          "name": "authority",
          "writable": true,
          "relations": [
            "property"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimRent",
      "docs": [
        "Инвестор забирает накопленный арендный доход"
      ],
      "discriminator": [
        57,
        233,
        51,
        137,
        102,
        101,
        26,
        101
      ],
      "accounts": [
        {
          "name": "property",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "property.authority",
                "account": "property"
              },
              {
                "kind": "account",
                "path": "property.id",
                "account": "property"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "property"
              },
              {
                "kind": "account",
                "path": "investor"
              }
            ]
          }
        },
        {
          "name": "investor",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "createProperty",
      "docs": [
        "Листинг нового объекта недвижимости"
      ],
      "discriminator": [
        45,
        115,
        89,
        113,
        193,
        252,
        125,
        27
      ],
      "accounts": [
        {
          "name": "property",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "location",
          "type": "string"
        },
        {
          "name": "totalShares",
          "type": "u64"
        },
        {
          "name": "pricePerShare",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositRent",
      "docs": [
        "Владелец вносит арендный доход; он распределяется по проданным долям"
      ],
      "discriminator": [
        54,
        14,
        183,
        244,
        81,
        178,
        23,
        27
      ],
      "accounts": [
        {
          "name": "property",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "property.id",
                "account": "property"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "property"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "property",
      "discriminator": [
        195,
        247,
        69,
        181,
        195,
        47,
        152,
        19
      ]
    }
  ],
  "events": [
    {
      "name": "propertyCreated",
      "discriminator": [
        106,
        97,
        20,
        82,
        86,
        26,
        248,
        10
      ]
    },
    {
      "name": "rentClaimed",
      "discriminator": [
        33,
        17,
        4,
        121,
        228,
        7,
        100,
        136
      ]
    },
    {
      "name": "rentDeposited",
      "discriminator": [
        171,
        133,
        235,
        59,
        181,
        138,
        170,
        226
      ]
    },
    {
      "name": "sharesPurchased",
      "discriminator": [
        24,
        220,
        223,
        28,
        213,
        182,
        47,
        22
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidName",
      "msg": "Name must be 1..=48 bytes"
    },
    {
      "code": 6001,
      "name": "invalidLocation",
      "msg": "Location must be <= 64 bytes"
    },
    {
      "code": 6002,
      "name": "invalidShares",
      "msg": "Share amount must be greater than zero"
    },
    {
      "code": 6003,
      "name": "invalidPrice",
      "msg": "Price must be greater than zero"
    },
    {
      "code": 6004,
      "name": "invalidAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6005,
      "name": "notEnoughShares",
      "msg": "Not enough shares available"
    },
    {
      "code": 6006,
      "name": "noShareholders",
      "msg": "No shares sold yet — nobody to distribute rent to"
    },
    {
      "code": 6007,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6008,
      "name": "wrongAuthority",
      "msg": "Signer is not the expected authority"
    },
    {
      "code": 6009,
      "name": "mathOverflow",
      "msg": "Math overflow"
    }
  ],
  "types": [
    {
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "property",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "rewardDebt",
            "docs": [
              "shares × acc на момент последнего пересчёта — уже \"учтённый\" доход"
            ],
            "type": "u128"
          },
          {
            "name": "unclaimed",
            "docs": [
              "Начисленный, но ещё не выплаченный доход"
            ],
            "type": "u64"
          },
          {
            "name": "totalClaimed",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "property",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "location",
            "type": "string"
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "sharesSold",
            "type": "u64"
          },
          {
            "name": "pricePerShare",
            "docs": [
              "Цена одной доли в lamports"
            ],
            "type": "u64"
          },
          {
            "name": "accRentPerShare",
            "docs": [
              "Накопленный доход на одну долю × ACC_SCALE"
            ],
            "type": "u128"
          },
          {
            "name": "totalRentDeposited",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "propertyCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "property",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "pricePerShare",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rentClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "property",
            "type": "pubkey"
          },
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rentDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "property",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sharesPurchased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "property",
            "type": "pubkey"
          },
          {
            "name": "investor",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "cost",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
