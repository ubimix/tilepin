var expect = require('expect.js');
var TileSourceProvider = require('../tilepin-provider');
var $ = require('cheerio');
var _ = require('underscore');
var Path = require('path');

function MyType(name) {
    if (!this.id) {
        this.id = 'id-' + (new Date()).getTime();
    }
    this.name = name;
}
MyType.prototype.sayHello = function() {
    return 'Hello ' + this.name;
}
describe('Tilepin DataSource provider', function() {

    var dir;
    var provider;
    beforeEach(function() {
        var path = './tests';
        dir = Path.resolve(process.cwd(), path);
        provider = new TileSourceProvider.TileMillProvider({
            dir : dir
        });
    });
    it('should load external files', function(done) {
        provider.loadTileSource({
            source : 'project'
        }).then(
                function(result) {
                    var dom = $(result.xml);
                    var fileElm = dom
                            .find('layer datasource parameter[name="file"]');
                    expect(fileElm[0]).not.to.be(null);

                    var expectedPath = Path.resolve(dir,
                            'project/layers/ne_110m_admin_0_countries/'
                                    + 'ne_110m_admin_0_countries.shp');
                    expect(fileElm.contents() + '').to.eql('<!--[CDATA['
                            + expectedPath + ']]-->');
                    // console.log(_.functions(fileElm));
                }).fin(function() {
            done();
        }).done();

        var a = new MyType('John');
        expect('Hello John').to.eql(a.sayHello());
        // console.log(a.sayHello());
    })
});
