var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');
var Tilepin = require('../lib/');
var ProjectLoader = require('../tilepin-loader');
var ProjectManager = require('../tilepin-provider');
var TilesProvider = require('../tilepin').TilesProvider;

var projectsDir = Path.join(__dirname, 'projects');
var options = {
    dir : projectsDir
};

function getHash(buf) {
    return require('crypto').createHash('sha1').update(buf).digest('hex')
}

function toString(obj) {
    return JSON.stringify(obj, null, 2);
}

describe('TilesProvider', function() {

    it('should create PNG tiles', //
    suite(function(done) {
        var provider = new TilesProvider(options);
        var params = {
            source : '01-simple-tilemill-project',
            format : 'png',
            z : 1,
            x : 0,
            y : 0,
        };
        return Tilepin.P().then(function() {
            return provider.invalidate(params);
        }).then(function() {
            return provider.loadTile(params);
        }).then(
                function(info) {
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.png');
                    return Tilepin.P.ninvoke(FS, 'readFile', file).then(
                            function(buf) {
                                var first = getHash(info.tile);
                                var second = getHash(buf);
                                // Tilepin.P.ninvoke(FS, 'writeFile',
                                // 'tile.png', info.tile);
                                expect(first).to.eql(second);
                            })
                });
    }))

    it('should generate UTFGrid tiles', //
    suite(function() {
        var provider = new TilesProvider(options);
        return provider.loadTile({
            source : '01-simple-tilemill-project',
            format : 'grid.json',
            z : 1,
            x : 0,
            y : 0,
        }).then(
                function(info) {
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.grid.json');
                    return Tilepin.P.ninvoke(FS, 'readFile', file, 'UTF-8')
                            .then(function(buf) {
                                var first = toString(info.tile);
                                expect(first).to.eql(buf);
                            })
                });
    }));

    it('should allow to pre-process datalayers before loading', //
    suite(function() {
        var test = null;
        var provider = new TilesProvider(_.extend({
            handleDatalayer : function(options) {
                expect(options).not.to.be(null);
                var dataLayer = options.dataLayer
                expect(dataLayer).not.to.be(null);
                expect(dataLayer.Datasource).not.to.be(null);
                test = dataLayer.Datasource.file;
            }
        }, options));

        return provider.invalidate({
            source : '01-simple-tilemill-project'
        }).then(function() {
            return provider.loadTile({
                source : '01-simple-tilemill-project',
                format : 'grid.json',
                z : 1,
                x : 0,
                y : 0,
            });
        }).then(
                function(info) {
                    var expected = Path.resolve(__dirname,
                            'projects/01-simple-tilemill-project/data/'
                                    + 'ne_110m_admin_0_countries/'
                                    + 'ne_110m_admin_0_countries.shp');
                    expect(test).to.eql(expected);
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.grid.json');
                    // return Tilepin.P.ninvoke(FS, 'writeFile', file,
                    // toString(info.tile), 'UTF-8');
                    return Tilepin.P.ninvoke(FS, 'readFile', file, 'UTF-8')
                            .then(function(buf) {
                                var first = toString(info.tile);
                                expect(first).to.eql(buf);
                            })
                });
    }));
});

function suite(test) {
    return function(done) {
        return Tilepin.P().then(test).then(done, function(err) {
            done();
            throw err;
        }).done();
    }
}