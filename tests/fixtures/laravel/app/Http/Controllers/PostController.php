<?php

namespace App\Http\Controllers;

use App\Models\Post;
use Illuminate\Http\Request;

class PostController extends Controller
{
    public function index()
    {
        $posts = Post::with('author')->latest()->paginate(10);
        return view('posts.index', compact('posts'));
    }

    public function show(Post $post)
    {
        return view('posts.show', ['post' => $post]);
    }

    public function create()
    {
        return view('posts.create');
    }

    public function store(Request $request)
    {
        $data = $request->validate(['title' => 'required']);
        Post::create($data);
        return redirect()->route('posts.index')->with('success', 'Created');
    }

    public function edit(Post $post)
    {
        return view('posts.create', compact('post'));
    }

    public function update(Request $request, Post $post)
    {
        $post->update($request->all());
        return back();
    }

    public function destroy(Post $post)
    {
        $post->delete();
        return redirect()->route('posts.index');
    }

    public function apiIndex()
    {
        return response()->json(Post::all());
    }
}
