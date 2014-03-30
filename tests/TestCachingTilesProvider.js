var expect = require('expect.js');
var Tilepin = require('../tilepin');
var $ = require('cheerio');
var _ = require('underscore');
var Q = require('q');
var FS = require('fs');
var Path = require('path');

function TestTilesProvider(options) {
    this.options = options;
}
_.extend(TestTilesProvider.prototype, Tilepin.TilesProvider.prototype, {
    formats : [ 'foo' ],
    loadTile : function(params) {
        this._hits = this._hits || 0;
        this._hits++;
        return Q(this.options.name);
    },
    getHits : function() {
        return this._hits;
    }
});

describe('Tilepin.CachingTilesProvider '
        + 'and Tilepin.DispatchingTilesProvider', function() {

    it('should handle caching and dispatching', function(done) {
        var providers = {
            projectOne : new TestTilesProvider({
                name : 'one'
            }),
            projectTwo : new TestTilesProvider({
                name : 'two'
            }),
        }
        var provider = new Tilepin.CachingTilesProvider({
            provider : new Tilepin.DispatchingTilesProvider({
                getProvider : function(params) {
                    return Q(providers[params.source]);
                }
            })
        })
        var params = {
            source : 'projectOne',
            x : 1,
            y : 2,
            z : 3,
            format : 'foo'
        }
        return Q()
        // The first call hits the original source of tiles. Cache is
        // not used.
        .then(function() {
            return provider.loadTile(params).then(function(result) {
                expect(result).to.eql('one');
                expect(providers.projectOne.getHits()).to.eql(1);
            });
        })
        // Reloads the tile; It should not hit the original tile source;
        // The result comes from the cache.
        .then(function() {
            return provider.loadTile(params).then(function(result) {
                expect(result).to.eql('one');
                expect(providers.projectOne.getHits()).to.eql(1);
            });
        })
        // Reset cache and load tiles again. It should hit the original
        // source.
        .then(function() {
            return provider.invalidate(params).then(function() {
                return provider.loadTile(params).then(function(result) {
                    expect(result).to.eql('one');
                    expect(providers.projectOne.getHits()).to.eql(2);
                });
            });
        })
        //
        .fin(done).done();
    })

});

function getHash(buf) {
    return require('crypto').createHash('sha1').update(buf).digest('hex')
}
describe('Tilepin.ProjectBasedTilesProvider', function() {
    it('should generate image tiles', function(done) {
        var dir = __dirname;
        var provider = new Tilepin.ProjectBasedTilesProvider({
            dir : dir
        });
        Q().then(function() {
            return provider.invalidate({
                source : 'project'
            });
        }).then(function() {
            return provider.loadTile({
                source : 'project',
                x : 0,
                y : 0,
                z : 1,
                format : 'tile'
            });
        })
        //
        // .then(
        // function(info) {
        // return Q.ninvoke(FS, 'writeFile', './tile-1-0-0.png',
        // info.tile).then(function() {
        // return info;
        // });
        // })
        //
        .then(function(info) {
            var file = Path.resolve(dir, './expected/expected-tile-1-0-0.png');
            return Q.ninvoke(FS, 'readFile', file).then(function(buf) {
                var first = getHash(info.tile);
                var second = getHash(buf);
                expect(first).to.eql(second);
            })
        }).fin(done).done();
    });

});
