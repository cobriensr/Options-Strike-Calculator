# Ticker discovery audit

Scanned 18 parquets (2026-04-13 → 2026-05-06).

Excluded: 53 tickers already in the universe.

Volume floor: 50,000 prints across the window.


## Ranked candidates by qualifying-fire count

    ticker      volume  chains  raw_fires  qualifying  per_day
    CRWV       762,544  14,058      2,393       1,191     66.2
    IBIT       830,411  14,032      1,934       1,045     58.1
    NFLX     1,536,683  15,439      1,776         999     55.5
    ARM        487,548   8,328      1,925         988     54.9
    OKLO       427,775   8,266      1,798         941     52.3
    APLD       350,488   7,044      1,737         858     47.7
    QCOM       548,032   6,916      1,717         838     46.6
    IONQ       381,732   7,044      1,722         835     46.4
    BE         379,135  10,623      1,373         756     42.0
    NOW        479,322  10,324      1,460         742     41.2
    HIMS       584,238   9,245      1,806         739     41.1
    CAR        658,303  11,130      3,052         739     41.1
    IREN       675,927  10,456      1,616         737     40.9
    ASTS       603,118  10,770      1,830         737     40.9
    NBIS       512,731  11,105      1,855         708     39.3
    CRCL       367,508   7,633      1,805         660     36.7
    LITE       236,008   7,753        974         572     31.8
    LLY        309,773   8,834        780         550     30.6
    BABA       401,422   6,947        893         509     28.3
    NVTS       230,656   4,763      1,225         465     25.8
    CVNA       323,306   6,767        862         444     24.7
    GME        645,083   6,638        997         439     24.4
    TLT        505,902   8,959        484         437     24.3
    BA         310,682   6,304        659         432     24.0
    AAOI       261,701   6,710      1,236         410     22.8
    CRWD       231,595   6,837        762         405     22.5
    APP        246,012   7,648      1,120         381     21.2
    CRM        271,303   6,622        702         354     19.7
    PYPL       248,137   5,456        528         309     17.2
    CAT        224,922   6,861        382         306     17.0
    GLW        234,672   5,854        593         291     16.2
    POET       331,013   4,195      1,461         286     15.9
    NOK        354,124   3,683        640         282     15.7
    NKE        339,639   6,305        451         269     14.9
    CIFR       262,024   4,783        816         254     14.1
    ADBE       255,738   6,851        504         250     13.9
    XSP        819,726  15,275        234         234     13.0
    MARA       397,777   5,116        596         233     12.9
    NVO        240,134   4,977        467         229     12.7
    BMNR       298,384   6,120        596         172      9.6
    XLE        257,383   4,966        197         152      8.4
    ONDS       325,268   4,412        419         145      8.1
    GS         290,816   8,864        297         143      7.9
    AAL        224,113   3,698        399         138      7.7
    GLD        870,919  20,091        197         111      6.2
    BAC        259,633   4,029        149          79      4.4
    BYND       228,390   1,894        233          39      2.2
    DIA        243,657   5,604         10           8      0.4
    COST       278,066   6,804          5           4      0.2
    SPX        754,631  26,351          2           1      0.1

## Recommended additions (≥50 qualifying fires across window)

    ticker   qualifying  per_day  suggested mode
    CRWV          1,191     66.2  B (DTE 1-3 / EXTENDED)
    IBIT          1,045     58.1  B (DTE 1-3 / EXTENDED)
    NFLX            999     55.5  B (DTE 1-3 / EXTENDED)
    ARM             988     54.9  A (0DTE / V3)
    OKLO            941     52.3  A (0DTE / V3)
    APLD            858     47.7  A (0DTE / V3)
    QCOM            838     46.6  B (DTE 1-3 / EXTENDED)
    IONQ            835     46.4  A (0DTE / V3)
    BE              756     42.0  A (0DTE / V3)
    NOW             742     41.2  A (0DTE / V3)
    HIMS            739     41.1  B (DTE 1-3 / EXTENDED)
    CAR             739     41.1  B (DTE 1-3 / EXTENDED)
    IREN            737     40.9  B (DTE 1-3 / EXTENDED)
    ASTS            737     40.9  B (DTE 1-3 / EXTENDED)
    NBIS            708     39.3  B (DTE 1-3 / EXTENDED)
    CRCL            660     36.7  A (0DTE / V3)
    LITE            572     31.8  A (0DTE / V3)
    LLY             550     30.6  A (0DTE / V3)
    BABA            509     28.3  A (0DTE / V3)
    NVTS            465     25.8  A (0DTE / V3)