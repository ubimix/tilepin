var Tilepin = require('../lib/Tilepin.ProjectConfig.js');
require('../lib/Tilepin.P');
require('../lib/Tilepin.PgConnector');

var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');

describe('Tilepin.PostgresConnect', function() {
    it('should be able to connect to postgres db', suite(function() {
        var conString = "postgres://postgres@localhost/paris-region-map";
        var connector = new Tilepin.PgConnector({
            url : conString
        });
        var sql = 'select id, type, properties, '
                + 'st_asgeojson(geometry) as geometry '
                + 'from objects where type=$1';
        return connector.exec({
            query : sql,
            params : [ 'Organization' ],
            offset : 1,
            limit : 10
        }).then(function(results) {
            console.log(JSON.stringify(results, null, 2));
        })
    }));
})

function suite(test) {
    return function(done) {
        return Tilepin.P().then(test).then(done, function(err) {
            done(err);
        }).done();
    }
}