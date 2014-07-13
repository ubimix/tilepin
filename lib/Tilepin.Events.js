var Tilepin = module.exports = require('./Tilepin');
var _ = require('underscore');

/** Events mixins */
Tilepin.Events = {

    /** Registers listeners for the specified event key. */
    on : function(eventKey, handler, context) {
        var listeners = this.__listeners = this.__listeners || {};
        context = context || this;
        var list = listeners[eventKey] = listeners[eventKey] || [];
        list.push({
            handler : handler,
            context : context
        });
    },
    /** Removes a listener for events with the specified event key */
    off : function(eventKey, handler, context) {
        var listeners = this.__listeners;
        if (!listeners)
            return;
        var list = listeners[eventKey];
        if (!list)
            return;
        list = _.filter(list, function(slot) {
            var match = (slot.handler === handler);
            match &= (!context || slot.context === context);
            return !match;
        })
        listeners[eventKey] = list.length ? list : undefined;
    },
    /** Fires an event with the specified key. */
    fire : function(eventKey) {
        var listeners = this.__listeners;
        if (!listeners)
            return;
        var list = listeners[eventKey];
        if (!list)
            return;
        var args = _.toArray(arguments);
        args.splice(0, 1);
        _.each(list, function(slot) {
            slot.handler.apply(slot.context, args);
        })
    },
}

/** Event manager */
Tilepin.EventManager = EventManager;
function EventManager() {
}
_.extend(EventManager.prototype, Tilepin.Events);

/** Additional method mixins */
Tilepin.Events.Mixin = {

    /** Listens to events produced by external objects */
    listenTo : function(obj, event, handler, context) {
        var listeners = this._listeners = this._listeners || [];
        context = context || this;
        obj.on(event, handler, context);
        listeners.push({
            obj : obj,
            event : event,
            handler : handler,
            context : context
        });
    },

    /** Removes all event listeners produced by external objects. */
    stopListening : function() {
        _.each(this._listeners, function(listener) {
            var context = listener.context || this;
            listener.obj.off(listener.event, listener.handler, context);
        }, this);
        delete this._listeners;
    },

    /**
     * Trigger an event and/or a corresponding method name. Examples:
     * 
     * <ul>
     * <li> `this.triggerMethod(&quot;foo&quot;)` will trigger the
     * &quot;foo&quot; event and call the &quot;onFoo&quot; method.</li>
     * <li> `this.triggerMethod(&quot;foo:bar&quot;) will trigger the
     * &quot;foo:bar&quot; event and call the &quot;onFooBar&quot; method.</li>
     * </ul>
     * 
     * This method was copied from Marionette.triggerMethod.
     */
    triggerMethod : (function() {
        // split the event name on the :
        var splitter = /(^|:)(\w)/gi;
        // take the event section ("section1:section2:section3")
        // and turn it in to uppercase name
        function getEventName(match, prefix, eventName) {
            return eventName.toUpperCase();
        }
        // actual triggerMethod name
        var triggerMethod = function(event) {
            // get the method name from the event name
            var methodName = 'on' + event.replace(splitter, getEventName);
            var method = this[methodName];
            // trigger the event, if a trigger method exists
            if (_.isFunction(this.fire)) {
                this.fire.apply(this, arguments);
            }
            // call the onMethodName if it exists
            if (_.isFunction(method)) {
                // pass all arguments, except the event name
                return method.apply(this, _.tail(arguments));
            }
        };
        return triggerMethod;
    })(),

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
                    that.fire(begin.eventName, _.extend({
                        arguments : args
                    }, begin));
                }).then(function() {
                    return m.apply(obj, args);
                }).then(function(result) {
                    that.fire(end.eventName, _.extend({
                        arguments : args,
                        result : result
                    }, end));
                    return result;
                }, function(err) {
                    that.fire(end.eventName, _.extend({
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
                    that.fire(begin.eventName, _.extend({
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
                    that.fire(end.eventName, _.extend({
                        arguments : args,
                        results : result
                    }, end));
                    return callback.apply(self, result);
                }, function(err) {
                    that.fire(end.eventName, _.extend({
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

};