from flask import Blueprint, Flask, jsonify, redirect, render_template, request, url_for

app = Flask(__name__)
bp = Blueprint("blog", __name__, url_prefix="/blog")


@app.route("/")
def index():
    return render_template("index.html", title="Home")


@bp.route("/new", methods=["GET", "POST"])
def new_post():
    if request.method == "POST":
        title = request.form["title"]
        return redirect(url_for("blog.list_posts"))
    return render_template("index.html", title="New")


@bp.get("/api")
def list_posts():
    return jsonify([])


app.register_blueprint(bp)

if __name__ == "__main__":
    app.run(debug=True)
