@extends('layouts.app')
@section('content')
@foreach ($posts as $post)
  <a href="{{ route('posts.show', $post) }}">{{ $post->title }}</a>
@endforeach
@endsection
