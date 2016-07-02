var numeral = require('numeral')
  , colors = require('colors')
  , tb = require('timebucket')
  , zerofill = require('zero-fill')
  , moment = require('moment')

module.exports = function container (get, set, clear) {
  var getTime = get('utils.getTime')
  return function (options) {
    var bot = options || {}
    var conf = get('conf.bot')
    Object.keys(conf).forEach(function (k) {
      if (typeof bot[k] === 'undefined') {
        bot[k] = JSON.parse(JSON.stringify(conf[k]))
      }
    })
    var initBalance = JSON.parse(JSON.stringify(bot.balance))
    var side = null
    var periodVol = 0
    var runningVol = 0, runningTotal = 0
    var high = 0, low = 10000, vol = 0
    var maxDiff = 0
    var buyPrice = null, sellPrice = null
    var tradeVol = 0
    var cooldown = 0
    var lastTick = null
    var volDiff = ''
    var lastHour = null
    var hourVol = 0

    if (bot.tweet) {
      var twitterClient = get('utils.twitterClient')
      function onTweet (err, data, response) {
        if (err) return get('console').error('tweet err', err)
        if (response.statusCode === 200 && data && data.id_str) {
          get('console').log('tweeted: '.cyan + data.text.white)
        }
        else get('console').error('tweet err', response.statusCode, data)
      }
    }
    if (bot.trade) {
      var client = get('utils.gdaxAuthedClient')
      var memId = get('conf.product_id')
      get('console').log('entering zen mode...')
      syncBalance(function (err) {
        if (err) throw err
        bot.trade = false
        get('db.mems').load(memId, function (err, mem) {
          if (err) throw err
          if (mem) {
            side = mem.side
            runningVol = mem.runningVol
            runningTotal = mem.runningTotal
            high = mem.high
            low = mem.low
            vol = mem.vol
            maxDiff = mem.maxDiff
            buyPrice = mem.buyPrice
            sellPrice = mem.sellPrice
            tradeVol = mem.tradeVol
            cooldown = mem.cooldown
            lastTick = mem.lastTick
            lastHour = mem.lastHour
            hourVol = mem.hourVol
            initBalance = mem.balance // consolidated to currency
            get('console').log('memory loaded.'.white + ' resuming trading!'.cyan)
            bot.trade = true
          }
          else {
            initBalance = JSON.parse(JSON.stringify(bot.balance))
            get('utils.gdaxClient').getProductTicker(function (err, resp, ticker) {
              if (err) throw err
              if (resp.statusCode !== 200) {
                console.error(ticker)
                throw new Error('non-200 status from GDAX: ' + resp.statusCode)
              }
              initBalance.currency = numeral(initBalance.currency)
                .add(numeral(initBalance.asset).multiply(ticker.price))
                .value()
              initBalance.asset = 0
            })
            get('console').log('no memory found.'.red + ' starting trading!'.cyan)
            bot.trade = true
          }
        })
      })
    }
    function syncBalance (cb) {
      if (!bot.trade) return cb && cb()
      bot.trade = false
      client.getAccounts(function (err, resp, accounts) {
        if (err) throw err
        if (resp.statusCode !== 200) {
          console.error(accounts)
          throw new Error('non-200 status from GDAX: ' + resp.statusCode)
        }
        accounts.forEach(function (account) {
          switch (account.currency) {
            case 'USD':
              bot.balance.currency = numeral(account.balance).value()
              break;
            case 'BTC':
              bot.balance.asset = numeral(account.balance).value()
              break;
          }
        })
        bot.trade = true
        cb && cb()
      })
    }

    function getGraph () {
      var thisTotal = numeral(high).add(low).add(lastTick.close).divide(3).multiply(periodVol).value()
      runningTotal = numeral(runningTotal).add(thisTotal).value()
      runningVol = numeral(runningVol).add(periodVol).value()
      var vwap = numeral(runningTotal).divide(runningVol).value()
      var vwapDiff = numeral(lastTick.close).subtract(vwap).value()
      maxDiff = Math.max(maxDiff, Math.abs(vwapDiff))
      var barWidth = 20
      var half = barWidth / 2
      var bar = ''
      if (vwapDiff > 0) {
        bar += ' '.repeat(half)
        var stars = Math.min(Math.round((vwapDiff / maxDiff) * half), half)
        bar += '+'.repeat(stars).green.bgGreen
        bar += ' '.repeat(half - stars)
      }
      else if (vwapDiff < 0) {
        var stars = Math.min(Math.round((Math.abs(vwapDiff) / maxDiff) * half), half)
        bar += ' '.repeat(half - stars)
        bar += '-'.repeat(stars).red.bgRed
        bar += ' '.repeat(half)
      }
      else {
        bar += ' '.repeat(half * 2)
      }
      high = 0
      low = 10000
      return bar
    }

    /* report vars

    side = taker side by volume majority of all processed ticks
    vol = positive volume by side, until trigger resets it
    periodVol = trade volume since last report
    high = high price since last report
    low = low price since last report
    cooldown = number of reports until trigger can re-fire
    lastTick = last tick processed
    runningTotal = running volume-weighted typical price
    runningVol = running volume
    buyPrice = price bot last bought at
    sellPrice = price bot last sold at
    tradeVol = total trade volume of bot
    lastHour = hour-granularity timebucket string of last tick processed
    hourVol = volume since last hour report
    */

    function write (tick) {
      if (!lastTick) {
        initBalance.currency += initBalance.asset * tick.close
        initBalance.asset = 0
      }
      periodVol = numeral(periodVol).add(tick.vol).value()
      hourVol = numeral(hourVol).add(tick.vol).value()
      high = Math.max(high, tick.high)
      low = Math.min(low, tick.low)

      if (side && tick.side !== side) {
        vol = numeral(vol).subtract(tick.vol).value()
        if (vol < 0) side = tick.side
        vol = Math.abs(vol)
      }
      else {
        side = tick.side
        vol = numeral(vol).add(tick.vol).value()
      }
      var volString = zerofill(3, Math.round(vol), ' ').white
      volDiff = volString + ' ' + (side === 'BUY' ? 'BULL'.green : 'BEAR'.red)
      if (vol >= bot.min_vol) {
        // trigger
        if (cooldown) cooldown--
        if (vol >= bot.vol_reset) {
          vol = 0
        }
        if (side === 'BUY' && !bot.balance.currency) {
          return finish()
        }
        else if (side === 'SELL' && !bot.balance.asset) {
          return finish()
        }
        else if (side === 'BUY') {
          if (cooldown > 0) {
            return finish()
          }
          var delta = numeral(1).subtract(numeral(tick.close).divide(lastTick.close)).value()
          var price = numeral(tick.close).add(numeral(tick.close).multiply(bot.markup)).value() // add markup
          var vwap = numeral(runningTotal).divide(runningVol).value()
          var vwapDiff = numeral(price).subtract(vwap).value()
          var spend
          if (vwapDiff > 0) {
            // buy more when price is rising
            spend = numeral(bot.balance.currency).multiply(bot.trade_amt).value()
          }
          else {
            // buy less when price is falling
            spend = numeral(bot.balance.currency).multiply(numeral(1).subtract(bot.trade_amt)).value()
          }
          if (spend / price < bot.min_trade) {
            return finish()
          }
          if (sellPrice && price > sellPrice) {
            var sellDelta = numeral(1).subtract(numeral(sellPrice).divide(price))
            if (sellDelta >= bot.buy_for_more) {
              return finish()
            }
          }
          if (delta >= bot.crash_protection) {
            cooldown = 0
            return finish()
          }
          get('console').log(('[bot] volume trigger ' + side + ' ' + numeral(vol).format('0.0') + ' >= ' + numeral(bot.min_vol).format('0.0')).grey)
          cooldown = bot.cooldown
          vol = 0
          buyPrice = price
          bot.balance.currency = numeral(bot.balance.currency).subtract(spend).value()
          var size = numeral(spend).divide(price).value()
          tradeVol = numeral(tradeVol).add(size).value()
          bot.balance.asset = numeral(bot.balance.asset).add(size).value()
          var fee = numeral(size).multiply(price).multiply(bot.fee).value()
          bot.balance.currency = numeral(bot.balance.currency).subtract(fee).value()
          get('console').log(('[bot] BUY ' + numeral(size).format('0.000') + ' BTC at ' + numeral(price).format('$0,0.00') + ' ' + numeral(delta).format('0.000%')).cyan)
          if (bot.trade) {
            var buyParams = {
              'type': 'market',
              'size': numeral(size).format('00.000'),
              'product_id': get('conf.product_id'),
            }
            client.buy(buyParams, function (err, resp, order) {
              onOrder(err, resp, order)
              if (bot.tweet) {
                var tweet = {
                  status: 'zenbot recommends:\n\naction: BUY\nprice: ' + numeral(price).format('$0,0.00') + '\ntime: ' + getTime() + '\n\n#btc #gdax'
                }
                twitterClient.post('statuses/update', tweet, onTweet)
              }
              syncBalance()
            })
          }
        }
        else if (side === 'SELL') {
          if (cooldown > 0) {
            get('console').log(('[bot] too soon to SELL').grey)
            return finish()
          }
          var price = numeral(tick.close).subtract(numeral(tick.close).multiply(bot.markup)).value()
          var delta = numeral(1).subtract(numeral(lastTick.close).divide(tick.close)).value()
          var vwap = numeral(runningTotal).divide(runningVol).value()
          var vwapDiff = numeral(price).subtract(vwap).value()
          var sell
          if (vwapDiff < 0) {
            // sell more when price is falling
            sell = numeral(bot.balance.asset).multiply(bot.trade_amt).value()
          }
          else {
            // sell less when price is rising
            sell = numeral(bot.balance.asset).multiply(numeral(1).subtract(bot.trade_amt)).divide(2).value()
          }
          if (sell < bot.min_trade) {
            return finish()
          }
          if (buyPrice && price < buyPrice) {
            var buyDelta = numeral(1).subtract(numeral(price).divide(buyPrice)).value()
            if (buyDelta >= bot.sell_for_less) {
              return finish()
            }
          }
          if (delta >= bot.crash_protection) {
            cooldown = 0
            return finish()
          }
          get('console').log(('[bot] volume trigger ' + side + ' ' + numeral(vol).format('0.0') + ' >= ' + numeral(bot.min_vol).format('0.0')).grey)
          cooldown = bot.cooldown
          vol = 0
          sellPrice = price
          bot.balance.asset = numeral(bot.balance.asset).subtract(sell).value()
          tradeVol = numeral(tradeVol).add(sell).value()
          bot.balance.currency = numeral(bot.balance.currency).add(numeral(sell).multiply(price)).value()
          var fee = numeral(sell).multiply(price).multiply(bot.fee).value()
          bot.balance.currency = numeral(bot.balance.currency).subtract(fee).value()
          get('console').log(('[bot] SELL ' + numeral(sell).format('00.000') + ' BTC at ' + numeral(price).format('$0,0.00') + ' ' + numeral(delta).format('0.000%')).cyan)
          if (bot.trade) {
            var sellParams = {
              'type': 'market',
              'size': numeral(sell).format('00.000'),
              'product_id': get('conf.product_id'),
            }
            client.sell(sellParams, function (err, resp, order) {
              onOrder(err, resp, order)
              if (bot.tweet) {
                var tweet = {
                  status: 'zenbot recommends:\n\naction: SELL\nprice: ' + numeral(price).format('$0,0.00') + '\ntime: ' + getTime() + '\n\n#btc #gdax'
                }
                twitterClient.post('statuses/update', tweet, onTweet)
              }
              syncBalance()
            })
          }
        }
        function onOrder (err, resp, order) {
          if (err) return get('console').error('order err', err, resp, order)
          if (resp.statusCode !== 200) {
            console.error(order)
            return get('console').error('non-200 status from GDAX: ' + resp.statusCode)
          }
          get('console').log(('[GDAX] order-id: ' + order.id).cyan)
          function getStatus () {
            client.getOrder(order.id, function (err, resp, order) {
              if (err) return get('console').error('getOrder err', err)
              if (resp.statusCode !== 200) {
                console.error(order)
                return get('console').error('non-200 status from GDAX getOrder: ' + resp.statusCode)
              }
              if (order.status === 'done') {
                return get('console').log(('[GDAX] order ' + order.id + ' done: ' + order.done_reason).cyan)
              }
              else {
                get('console').log(('[GDAX] order ' + order.id + ' ' + order.status).cyan)
                setTimeout(getStatus, 5000)
              }
            })
          }
          getStatus()
        }
      }
      finish()
      function finish () {
        lastTick = tick
      }
    }
    function end () {
      var newBalance = JSON.parse(JSON.stringify(bot.balance))
      if (lastTick) {
        newBalance.currency = numeral(newBalance.currency).add(numeral(newBalance.asset).multiply(lastTick.close)).value()
        newBalance.asset = 0
      }
      return {
        asset: newBalance.asset,
        currency: newBalance.currency,
        close: lastTick ? lastTick.close : null
      }
    }
    function report () {
      var time = get('utils.getTimestamp')(lastTick.time)
      var bar = getGraph()
      var newBalance = JSON.parse(JSON.stringify(bot.balance))
      newBalance.currency = numeral(newBalance.currency).add(numeral(newBalance.asset).multiply(lastTick.close)).value()
      newBalance.asset = 0
      var diff = newBalance.currency - initBalance.currency
      if (diff > 0) diff = ('+' + numeral(diff).format('$0,0.00')).green
      if (diff === 0) diff = ('+' + numeral(diff).format('$0,0.00')).white
      if (diff < 0) diff = (numeral(diff).format('$0,0.00')).red
      var status = [
        bar,
        numeral(lastTick.close).format('$0,0.00').yellow,
        volDiff,
        time.grey,
        numeral(bot.balance.asset).format('00.000').white,
        'BTC/USD'.grey,
        numeral(bot.balance.currency).format('$,0.00').yellow,
        diff
      ].join(' ')
      get('console').log(status)
      var thisHour = tb(lastTick.time).resize('1h').toString()
      var savedHourVol = hourVol
      if (thisHour !== lastHour) {
        hourVol = 0
        if (bot.tweet) {
          client.getProduct24HrStats(function (err, resp, stats) {
            if (err) return get('console').error('get stats err', err)
            if (resp.statusCode !== 200) {
              console.error(stats)
              return get('console').error('non-200 from GDAX stats: ' + resp.statusCode)
            }
            var diff = numeral(lastTick.close).subtract(stats.open).value()
            var diffStr = diff >= 0 ? '+' : '-'
            diffStr += numeral(Math.abs(diff)).format('$0.00')
            var vwap = numeral(runningTotal).divide(runningVol).value()
            var vwapDiff = numeral(lastTick.close).subtract(vwap).value()
            var vwapDiffStr = vwapDiff >= 0 ? '+' : '-'
            vwapDiffStr += numeral(Math.abs(vwapDiff)).format('$0.00')
            var text = [
              getTime() + ' report.\n',
              'close: ' + numeral(lastTick.close).format('$0,0.00'),
              'vs. vwap: ' + vwapDiffStr,
              'hr. volume: ' + numeral(Math.round(savedHourVol)).format('0,0'),
              'market: ' + (side === 'BUY' ? 'BULL' : 'BEAR'),
              '24hr. diff: ' + diffStr + '\n',
              '#btc #gdax'
            ].join('\n').trim()
            var tweet = {
              status: text
            }
            twitterClient.post('statuses/update', tweet, onTweet)
          })
        }
      }
      lastHour = thisHour
      if (bot.trade) {
        var mem = {
          id: memId,
          side: side,
          runningVol: runningVol,
          runningTotal: runningTotal,
          high: high,
          low: low,
          vol: vol,
          maxDiff: maxDiff,
          buyPrice: buyPrice,
          sellPrice: sellPrice,
          tradeVol: tradeVol,
          cooldown: cooldown,
          lastTick: lastTick,
          lastHour: lastHour,
          balance: newBalance,
          hourVol: savedHourVol
        }
        get('db.mems').save(mem, function (err, saved) {
          if (err) return get('console').error('mem save err', err)
        })
        syncBalance()
      }
      periodVol = 0
    }
    return {
      write: write,
      end: end,
      report: report
    }
  }
}