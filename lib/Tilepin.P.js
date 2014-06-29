var Tilepin = module.exports = require('./Tilepin');
var _ = require('underscore');
var P = Tilepin.P = require('when');

function array_slice(array, count) {
    return Array.prototype.slice.call(array, count);
}
P.nresolver = function(deferred) {
    return function(error, value) {
        if (error) {
            deferred.reject(error);
        } else if (arguments.length > 2) {
            deferred.resolve(array_slice(arguments, 1));
        } else {
            deferred.resolve(value);
        }
    };
}
P.ninvoke = P.ninvoke || function(object, name /* ...args */) {
    var nodeArgs = array_slice(arguments, 2);
    var deferred = P.defer();
    nodeArgs.push(P.nresolver(deferred));
    try {
        var f = _.isFunction(name) ? name : object[name];
        f.apply(object, nodeArgs);
    } catch (e) {
        deferred.reject(e);
    }
    return deferred.promise;
};
/**
 * Executes a specified method when the given promise completes (with a failure
 * or with a success).
 */
P.fin = function(promise, method) {
    return promise.then(function(result) {
        method();
        return result;
    }, function(err) {
        method();
        throw err;
    })
}
