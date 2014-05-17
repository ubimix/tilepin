var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');
var ProjectLoader = require('../tilepin-loader');
var ProjectManager = require('../tilepin-provider');
var P = require('../tilepin-commons').P;
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
    beforeEach(function() {
        console.log('-----------------')
    })

    it('should create PNG tiles', //
    suite(function(done) {
        var provider = new TilesProvider(options);
        var params = {
            source : 'project-01',
            format : 'png',
            z : 1,
            x : 0,
            y : 0,
        };
        return P().then(function() {
            console.log(provider.invalidate);
            return provider.invalidate(params);
        }).then(function() {
            return provider.loadTile(params);
        }).then(
                function(info) {
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.png');
                    return P.ninvoke(FS, 'readFile', file).then(function(buf) {
                        var first = getHash(info.tile);
                        var second = getHash(buf);

                        P.ninvoke(FS, 'writeFile', 'tile.png', info.tile);
                        console.log('AFTER GENERATION', first, second)
                        expect(first).to.eql(second);
                    })
                });
    }))

    it('should generate UTFGrid tiles', //
    suite(function() {
        var provider = new TilesProvider(options);
        return provider.loadTile({
            source : 'project-01',
            format : 'grid.json',
            z : 1,
            x : 0,
            y : 0,
        }).then(
                function(info) {
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.grid.json');
                    return P.ninvoke(FS, 'readFile', file, 'UTF-8').then(
                            function(buf) {
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
            source : 'project-01'
        }).then(function() {
            return provider.loadTile({
                source : 'project-01',
                format : 'grid.json',
                z : 1,
                x : 0,
                y : 0,
            });
        }).then(
                function(info) {
                    var expected = Path.resolve(__dirname,
                            'projects/project-01/data/'
                                    + 'ne_110m_admin_0_countries/'
                                    + 'ne_110m_admin_0_countries.shp');
                    expect(test).to.eql(expected);
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.grid.json');
                    // return P.ninvoke(FS, 'writeFile', file,
                    // toString(info.tile), 'UTF-8');
                    return P.ninvoke(FS, 'readFile', file, 'UTF-8').then(
                            function(buf) {
                                var first = toString(info.tile);
                                expect(first).to.eql(buf);
                            })
                });
    }));
});

function suite(test) {
    return function(done) {
        return P().then(test).then(done, function(err) {
            done();
            throw err;
        }).done();
    }
}