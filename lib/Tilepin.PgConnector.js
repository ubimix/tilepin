var Tilepin = module.exports = require('./Tilepin');
var Mosaic = require('mosaic-commons');
var _ = require('underscore');
var Pool = require('generic-pool').Pool;
var FS = require('fs');
var PG = require('pg.js')

Tilepin.PgConnector = PgConnector;

/**
 * This class allows query Postgres database and return results as JSON objects.
 * 
 * @param options.url
 *            url of the Db connection
 */
function PgConnector(options) {
    var that = this;
    that.options = options || {};
    if (!that.options.url)
        throw new Error('DB connection URL is not defined');
}

_.extend(PgConnector.prototype, {

    /** Executes the specified query and returns a list of results - JSON objects */
    exec : function(options) {
        var that = this;
        return that._connect(function(client) {
            var params = options.params || [];
            var query = that._prepareQuery(options);
            return Mosaic.P.ninvoke(client, 'query', query, params).then(
                    function(result) {
                        var list = [];
                        var features = {
                            features : list
                        };
                        _.each(result.rows, function(obj) {
                            if (_.isString(obj.geometry)) {
                                try {
                                    obj.geometry = JSON.parse(obj.geometry);
                                } catch (e) {
                                }
                            }
                            list.push(obj);
                        })
                        return features;
                    });
        });
    },

    /** Prepares the specified query based on the given parameters */
    _prepareQuery : function(options) {
        var query = options.query;
        var limit = +options.limit;
        var offset = +options.offset;
        query = 'select * from (' + query + ') as data ';
        if (!isNaN(offset) && offset > 0) {
            query += ' offset ' + offset;
        }
        if (!isNaN(limit) && limit >= 0) {
            query += ' limit ' + limit;
        }
        return query;
    },

    /**
     * Opens connection to the Db and calls the specified action with the
     * connection
     */
    _connect : function(action) {
        var that = this;
        return Mosaic.P().then(function() {
            var deferred = Mosaic.P.defer();
            PG.connect(that.options.url, function(err, client, done) {
                if (err) {
                    deferred.reject(err);
                    return;
                }
                return Mosaic.P().then(function() {
                    return action(client);
                }).then(function(result) {
                    done();
                    return result;
                }).then(function(result) {
                    deferred.resolve(result);
                }, function(err) {
                    deferred.reject(err);
                });
            })
            return deferred.promise;
        })
    }
})
