/* eslint-disable no-plusplus */

'use strict';

const cluster = require('cluster');
const log4js = require('../log4js');

/**
 * Takes a loggingEvent object, returns string representation of it.
 */
function serializeLoggingEvent(loggingEvent) {
  // JSON.stringify(new Error('test')) returns {}, which is not really useful for us.
  // The following allows us to serialize errors correctly.
  for (let i = 0; i < loggingEvent.data.length; i++) {
    const item = loggingEvent.data[i];
    // Validate that we really are in this case
    if (item && item.stack && JSON.stringify(item) === '{}') {
      loggingEvent.data[i] = { stack: item.stack };
    }
  }
  return JSON.stringify(loggingEvent);
}

/**
 * Takes a string, returns an object with
 * the correct log properties.
 *
 * This method has been "borrowed" from the `multiprocess` appender
 * by `nomiddlename`
 * (https://github.com/nomiddlename/log4js-node/blob/master/lib/appenders/multiprocess.js)
 *
 * Apparently, node.js serializes everything to strings when using `process.send()`,
 * so we need smart deserialization that will recreate log date and level for further
 * processing by log4js internals.
 */
function deserializeLoggingEvent(loggingEventString) {
  let loggingEvent;

  try {
    loggingEvent = JSON.parse(loggingEventString);
    loggingEvent.startTime = new Date(loggingEvent.startTime);
    loggingEvent.level = log4js.levels.toLevel(loggingEvent.level.levelStr);
    // Unwrap serialized errors
    for (let i = 0; i < loggingEvent.data.length; i++) {
      const item = loggingEvent.data[i];
      if (item && item.stack) {
        loggingEvent.data[i] = item.stack;
      }
    }
  } catch (e) {
    // JSON.parse failed, just log the contents probably a naughty.
    loggingEvent = {
      startTime: new Date(),
      categoryName: 'log4js',
      level: log4js.levels.ERROR,
      data: ['Unable to parse log:', loggingEventString]
    };
  }
  return loggingEvent;
}

/**
 * Creates an appender.
 *
 * If the current process is a master (`cluster.isMaster`), then this will be a "master appender".
 * Otherwise this will be a worker appender, that just sends loggingEvents to the master process.
 *
 * If you are using this method directly, make sure to provide it with `config.actualAppenders`
 * array of actual appender instances.
 *
 * Or better use `configure(config, options)`
 */
function createAppender(config) {
  if (cluster.isMaster) {
    const masterAppender = (loggingEvent) => {
      if (config.actualAppenders) {
        const size = config.actualAppenders.length;
        for (let i = 0; i < size; i++) {
          if (
            !config.appenders[i].category ||
            config.appenders[i].category === loggingEvent.categoryName
          ) {
            // Relying on the index is not a good practice but otherwise
            // the change would have been bigger.
            config.actualAppenders[i](loggingEvent);
          }
        }
      }
    };

    // Listen on new workers
    cluster.on('fork', (worker) => {
      worker.on('message', (message) => {
        if (message.type && message.type === '::log-message') {
          const loggingEvent = deserializeLoggingEvent(message.event);

          // Adding PID metadata
          loggingEvent.pid = worker.process.pid;
          loggingEvent.cluster = {
            master: process.pid,
            worker: worker.process.pid,
            workerId: worker.id
          };

          masterAppender(loggingEvent);
        }
      });
    });

    return masterAppender;
  }

  return (loggingEvent) => {
    // If inside the worker process, then send the logger event to master.
    if (cluster.isWorker) {
      // console.log("worker " + cluster.worker.id + " is sending message");
      process.send({ type: '::log-message', event: serializeLoggingEvent(loggingEvent) });
    }
  };
}

function configure(config, options) {
  if (config.appenders && cluster.isMaster) {
    const size = config.appenders.length;
    config.actualAppenders = new Array(size);

    for (let i = 0; i < size; i++) {
      log4js.loadAppender(config.appenders[i].type);
      config.actualAppenders[i] = log4js.appenderMakers[config.appenders[i].type](
        config.appenders[i],
        options
      );
    }
  }

  return createAppender(config);
}

module.exports.appender = createAppender;
module.exports.configure = configure;
