var Tilepin = module.exports = require('./Tilepin');
var Mosaic = require('mosaic-commons');
var _ = require('underscore');

/** Events mixins */
Tilepin.Events = {};

/** Additional method mixins */
Tilepin.Events.Mixin = _.extend({}, Mosaic.Events, {

    addEventTracing : function(obj, methods, that) {
        that = that || obj;
        function wrap(methodName, eventName, p) {
            var m = obj[methodName];
            if (!_.isFunction(m))
                return m;
            var begin = {
                obj : obj,
                method : methodName,
                eventName : eventName + ':begin'
            };
            var end = {
                obj : obj,
                method : methodName,
                eventName : eventName + ':end'
            }
            obj[methodName] = function(params) {
                var args = _.toArray(arguments);
                return Tilepin.P().then(function() {
                    that.emit(begin.eventName, _.extend({
                        arguments : args
                    }, begin));
                }).then(function() {
                    return m.apply(obj, args);
                }).then(function(result) {
                    that.emit(end.eventName, _.extend({
                        arguments : args,
                        result : result
                    }, end));
                    return result;
                }, function(err) {
                    that.emit(end.eventName, _.extend({
                        arguments : args,
                        error : err
                    }, end));
                    throw err;
                });
            }
        }
        _.each(methods, function(method) {
            var eventName;
            var methodName;
            var params;
            if (_.isString(method)) {
                methodName = method;
                eventName = method;
                params = {};
            } else {
                methodName = method.method;
                eventName = method.event;
                params = method.params || {};
            }
            wrap(methodName, eventName, params);
        })
    },

    addEventTracingWithCallbacks : function(obj, methods, that) {
        that = that || obj;
        function wrap(methodName, eventName) {
            var m = obj[methodName];
            if (!m || m._wrapped) {
                return;
            }
            var begin = {
                obj : obj,
                eventName : eventName + ':begin',
                method : methodName
            }
            var end = {
                obj : obj,
                eventName : eventName + ':end',
                method : methodName
            }
            var wrapper = function() {
                var self = this;
                var args = _.toArray(arguments);
                var callback = args.pop();
                var deferred = Tilepin.P.defer();
                try {
                    that.emit(begin.eventName, _.extend({
                        arguments : args
                    }, begin));
                    args.push(function() {
                        console.log(' * ', eventName)
                        deferred.resolve(_.toArray(arguments));
                    });
                    m.apply(obj, args);
                } catch (err) {
                    deferred.reject(err);
                }
                return deferred.promise.then(function(result) {
                    that.emit(end.eventName, _.extend({
                        arguments : args,
                        results : result
                    }, end));
                    return callback.apply(self, result);
                }, function(err) {
                    that.emit(end.eventName, _.extend({
                        arguments : args,
                        error : err
                    }, end));
                    return callback.apply(self, result);
                });
            }
            obj[methodName] = wrapper;
            wrapper._wrapped = true;
            console.log(methodName, eventName)
        }
        _.each(methods, function(method) {
            var eventName;
            var methodName;
            if (_.isString(method)) {
                methodName = method;
                eventName = method;
            } else {
                methodName = method.method;
                eventName = method.event;
            }
            wrap(methodName, eventName);
        })
        return obj;
    }
});
