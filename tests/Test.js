var expect = require('expect.js');
var TileSourceProvider = require('../tilepin-provider');
var $ = require('cheerio');
var _ = require('underscore');

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

    var provider;
    beforeEach(function() {
        provider = new TileSourceProvider.TileMillProvider({
            dir : './tests'
        })
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
                    expect(fileElm.contents() + '').to.eql('<!--[CDATA['
                            + 'layers/ne_110m_admin_0_countries/'
                            + 'ne_110m_admin_0_countries.shp' + ']]-->');
                    // console.log(_.functions(fileElm));
                }).fin(function() {
            done();
        }).done();

        var a = new MyType('John');
        expect('Hello John').to.eql(a.sayHello());
        // console.log(a.sayHello());
    })
});
